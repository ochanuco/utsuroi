/**
 * SSRF検査 (SPEC §15, ADR文書横断)。
 * checkUrlForSsrf: 同期的な静的検査 (scheme/userinfo/port/既知IPリテラル/既知ホスト名)。
 * resolveAndCheck: DNS rebinding対策として実際の名前解決結果まで検査する非同期版。
 */
import type { SsrfCheckResult } from '../shared/contracts';
import { classifyHostname, classifyIpAddress, parseIPv4, parseIPv6 } from './ip';

const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);
const DEFAULT_DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

function defaultPortFor(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

function allow(): SsrfCheckResult {
  return { allowed: true, reason: null };
}

function deny(reason: string): SsrfCheckResult {
  return { allowed: false, reason };
}

/**
 * 同期的なURL静的検査。DNS解決は行わない (ホスト名がIPリテラルでない限り既知ホスト名判定のみ)。
 */
export function checkUrlForSsrf(url: string): SsrfCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny('invalid_url');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return deny('scheme');
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return deny('userinfo');
  }

  const port = parsed.port === '' ? defaultPortFor(parsed.protocol) : Number(parsed.port);
  if (!ALLOWED_PORTS.has(port)) {
    return deny('port');
  }

  const hostname = parsed.hostname;
  if (hostname === '') {
    return deny('invalid_url');
  }

  const classification = classifyHostname(hostname);
  if (classification.blocked) {
    return deny(classification.reason ?? 'private');
  }

  return allow();
}

export interface DnsResolver {
  /** hostname を指定レコード種別で解決し、アドレス文字列の配列を返す (該当なしは空配列) */
  resolve(hostname: string, recordType: 'A' | 'AAAA'): Promise<string[]>;
}

interface DohAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;

function createDohResolver(fetchImpl: typeof fetch, endpoint: string): DnsResolver {
  return {
    async resolve(hostname: string, recordType: 'A' | 'AAAA'): Promise<string[]> {
      const wantedType = recordType === 'A' ? DNS_TYPE_A : DNS_TYPE_AAAA;
      const requestUrl = `${endpoint}?name=${encodeURIComponent(hostname)}&type=${recordType}`;
      const res = await fetchImpl(requestUrl, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`DoH request failed with status ${res.status}`);
      const body = (await res.json()) as DohResponse;
      if (body.Status !== 0) throw new Error(`DoH response indicates DNS error (Status ${body.Status})`);
      const answers = body.Answer ?? [];
      return answers.filter((a) => a.type === wantedType).map((a) => a.data);
    },
  };
}

export interface ResolveAndCheckOptions {
  /** DoH解決に使う fetch 実装。既定 globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** DoH エンドポイント。既定 https://cloudflare-dns.com/dns-query */
  dohEndpoint?: string;
  /** 名前解決の差し替え (テスト用スタブ)。指定時は fetchImpl/dohEndpoint は無視される */
  resolver?: DnsResolver;
}

/**
 * 静的検査に加えて、ホスト名を実際にDoHで解決し全解決先IPを私設域チェックにかける。
 * DNS rebinding (登録時は無害なIPを返し、接続時に private IP を返す攻撃) 対策。
 *
 * 制約: Cloudflare Workers の fetch() は接続先IPを指定できないため、ここで検査した解決先IPに
 * 実際の fetch 呼び出しを"ピン留め"することはできない (プラットフォーム制約)。resolveAndCheck は
 * 検査時点の名前解決結果のみを保証し、fetch実行時の再解決までは保証しない (TOCTOU の残存リスクは許容)。
 */
export async function resolveAndCheck(url: string, opts: ResolveAndCheckOptions = {}): Promise<SsrfCheckResult> {
  const staticResult = checkUrlForSsrf(url);
  if (!staticResult.allowed) return staticResult;

  const parsed = new URL(url);
  const hostname = parsed.hostname;

  // ホスト名自体が既にIPリテラルの場合は checkUrlForSsrf で検査済み (かつ許可済み)。DNS解決は不要。
  const bareHost = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const isIpLiteral = parseIPv4(bareHost) !== null || parseIPv6(bareHost) !== null;
  if (isIpLiteral) {
    return allow();
  }

  const resolver = opts.resolver ?? createDohResolver(opts.fetchImpl ?? globalThis.fetch.bind(globalThis), opts.dohEndpoint ?? DEFAULT_DOH_ENDPOINT);

  let addresses: string[];
  try {
    const [aRecords, aaaaRecords] = await Promise.all([resolver.resolve(hostname, 'A'), resolver.resolve(hostname, 'AAAA')]);
    addresses = [...aRecords, ...aaaaRecords];
  } catch {
    // 解決失敗時 (DoHの非2xx応答/DNSエラーStatus/例外/タイムアウト) は安全側 (拒否) に倒す
    return deny('dns_resolution_failed');
  }

  if (addresses.length === 0) {
    // 解決結果なし (NXDOMAIN等) も安全側 (拒否) に倒す。後続のfetchに委ねず、ここでfail closedする。
    return deny('dns_resolution_failed');
  }

  for (const address of addresses) {
    const classification = classifyIpAddress(address);
    if (classification.blocked) {
      return deny(classification.reason ?? 'private');
    }
  }

  return allow();
}
