/**
 * Service Binding RPC (FetchEntrypoint) の取得ロジック (ADR-0022)。
 * 呼び出し元ごとの許可ホスト・Fetcher 順を適用し、レジストリ経由で取得する。
 * Cloudflare Workers ランタイムに依存しない純粋なロジックとして切り出している。
 */
import { defaultFetcherRegistry, runFetcher } from '../fetch';
import type { FetcherRegistry } from '../fetch';
import { checkUrlForSsrf } from '../net';
import type { FetchOutcome } from '../shared/contracts';
import type { Env } from '../shared/env';
import { DEFAULT_PROCEEDABLE_FAILURES, NEVER_PROCEEDABLE_FAILURES } from '../shared/types';

export interface FetchPageRequest {
  url: string;
  maxBytes?: number;
  headers?: Record<string, string>;
}

export interface FetchPageResult {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  contentType: string | null;
  truncated: boolean;
  bytes: number;
  html: string;
  fetcherId: string | null;
  failureClass?: string;
}

export interface CallerConfig {
  allowedHosts: string[];
  fetchers: string[];
}

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const HARD_MAX_BYTES = 5 * 1024 * 1024;

/** 呼び出し元が指定できる request header。これ以外は無視する */
const FORWARDABLE_HEADERS: ReadonlySet<string> = new Set(['user-agent', 'accept', 'accept-language', 'referer']);
const MAX_HEADER_VALUE_LENGTH = 1024;

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
};

let warnedCallersRaw: string | undefined;

/** 不正な設定は空 (全拒否) として扱う。同じ不正値については 1 回だけログを出す */
export function parseCallers(raw: string | undefined): ReadonlyMap<string, CallerConfig> {
  const callers = new Map<string, CallerConfig>();
  if (raw === undefined || raw.trim() === '') return callers;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (warnedCallersRaw !== raw) {
      warnedCallersRaw = raw;
      console.error(JSON.stringify({ event: 'rpc_callers_invalid', reason: 'invalid_json' }));
    }
    return callers;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    if (warnedCallersRaw !== raw) {
      warnedCallersRaw = raw;
      console.error(JSON.stringify({ event: 'rpc_callers_invalid', reason: 'not_an_object' }));
    }
    return callers;
  }
  for (const [caller, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const { allowedHosts, fetchers } = value as Record<string, unknown>;
    if (!isStringArray(allowedHosts) || !isStringArray(fetchers)) continue;
    callers.set(caller, {
      allowedHosts: allowedHosts.map((h) => h.trim().toLowerCase()).filter((h) => h !== ''),
      fetchers,
    });
  }
  return callers;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function resolveCaller(rawCaller: unknown, env: Env): CallerConfig {
  if (typeof rawCaller !== 'string' || rawCaller === '') {
    console.error(JSON.stringify({ event: 'rpc_fetch_rejected', reason: 'missing_caller' }));
    throw new Error('rpc caller is not permitted');
  }
  const config = parseCallers(env.RPC_CALLERS).get(rawCaller);
  if (!config) {
    console.error(
      JSON.stringify({ event: 'rpc_fetch_rejected', reason: 'unregistered_caller', caller: rawCaller.slice(0, 64) }),
    );
    throw new Error('rpc caller is not permitted');
  }
  return config;
}

function blocked(url: unknown): FetchPageResult {
  return {
    ok: false,
    status: 0,
    statusText: '',
    url: typeof url === 'string' ? url : '',
    contentType: null,
    truncated: false,
    bytes: 0,
    html: '',
    fetcherId: null,
    failureClass: 'ssrf_blocked',
  };
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function resolveMaxBytes(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 1) return DEFAULT_MAX_BYTES;
  return Math.min(Math.floor(requested), HARD_MAX_BYTES);
}

function sanitizeHeaders(raw: unknown): { userAgent: string | null; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  let userAgent: string | null = null;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { userAgent, headers };
  for (const [name, value] of Object.entries(raw)) {
    const key = name.toLowerCase();
    if (!FORWARDABLE_HEADERS.has(key)) continue;
    if (typeof value !== 'string' || value.length > MAX_HEADER_VALUE_LENGTH || /[\r\n\0]/.test(value)) continue;
    if (key === 'user-agent') userAgent = value;
    else headers[key] = value;
  }
  return { userAgent, headers };
}

/** 次の Fetcher へ進んでよいか。HTTP 応答を得られた失敗は、再試行で結果が変わりうる分類以外は確定とする */
function shouldContinue(outcome: Extract<FetchOutcome, { ok: false }>): boolean {
  const cls = outcome.failureClass;
  if (NEVER_PROCEEDABLE_FAILURES.includes(cls)) return false;
  if (DEFAULT_PROCEEDABLE_FAILURES.includes(cls) || cls === 'http_403') return true;
  return outcome.status === null;
}

function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const label = contentType?.match(/charset\s*=\s*"?([^";\s]+)/i)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export interface FetchPageDeps {
  env: Env;
  caller: CallerConfig;
  callerName: string;
  registry?: FetcherRegistry;
}

function log(callerName: string, host: string | null, result: FetchPageResult): void {
  console.log(
    JSON.stringify({
      event: 'rpc_fetch',
      caller: callerName,
      host,
      fetcherId: result.fetcherId,
      status: result.status,
      failureClass: result.failureClass ?? null,
    }),
  );
}

export async function fetchPage(req: FetchPageRequest, deps: FetchPageDeps): Promise<FetchPageResult> {
  const { env, caller, callerName } = deps;
  const registry = deps.registry ?? defaultFetcherRegistry;
  const url = (req as { url?: unknown } | null)?.url;
  const host = typeof url === 'string' ? hostOf(url) : null;

  const allowed = new Set(caller.allowedHosts);
  const urlGuard = (candidate: string): { allowed: boolean; reason: string | null } => {
    const candidateHost = hostOf(candidate);
    if (candidateHost === null || !allowed.has(candidateHost)) return { allowed: false, reason: 'host_not_allowed' };
    return checkUrlForSsrf(candidate);
  };

  if (typeof url !== 'string' || host === null || !urlGuard(url).allowed) {
    const result = blocked(url);
    log(callerName, host, result);
    return result;
  }

  const maxBytes = resolveMaxBytes(req.maxBytes);
  const { userAgent, headers } = sanitizeHeaders(req.headers);

  let lastFailure: { fetcherId: string; outcome: Extract<FetchOutcome, { ok: false }> } | null = null;
  let lastStatus = 0;

  for (const fetcherId of caller.fetchers) {
    const outcome = await runFetcher(registry, fetcherId, {
      url,
      userAgent: userAgent ?? env.USER_AGENT,
      etag: null,
      lastModified: null,
      headers,
      env,
      urlGuard,
    });

    if (outcome.ok) {
      if (!urlGuard(outcome.finalUrl).allowed) {
        const result = blocked(url);
        log(callerName, host, result);
        return result;
      }
      const body = outcome.body ?? new Uint8Array(0);
      const truncated = body.byteLength > maxBytes;
      const kept = truncated ? body.subarray(0, maxBytes) : body;
      const result: FetchPageResult = {
        ok: outcome.status >= 200 && outcome.status < 300,
        status: outcome.status,
        statusText: STATUS_TEXT[outcome.status] ?? '',
        url: outcome.finalUrl,
        contentType: outcome.contentType,
        truncated,
        bytes: kept.byteLength,
        html: decodeBody(kept, outcome.contentType),
        fetcherId,
      };
      log(callerName, host, result);
      return result;
    }

    lastFailure = { fetcherId, outcome };
    if (outcome.status !== null) lastStatus = outcome.status;
    if (!shouldContinue(outcome)) break;
  }

  const failureClass = lastFailure?.outcome.failureClass ?? 'internal_error';
  const result: FetchPageResult = {
    ok: false,
    status: failureClass === 'ssrf_blocked' ? 0 : lastStatus,
    statusText: '',
    url,
    contentType: null,
    truncated: false,
    bytes: 0,
    html: '',
    fetcherId: failureClass === 'ssrf_blocked' ? null : (lastFailure?.fetcherId ?? null),
    failureClass,
  };
  log(callerName, host, result);
  return result;
}
