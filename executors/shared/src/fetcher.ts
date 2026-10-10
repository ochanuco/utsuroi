import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { isBlockedAddress, isBlockedHostname } from './addressPolicy.ts';

export type FailureClass = 'ssrf_blocked' | 'timeout' | 'network_error' | 'too_large';

export class FetchFailure extends Error {
  readonly failureClass: FailureClass;
  constructor(failureClass: FailureClass, message: string) {
    super(message);
    this.failureClass = failureClass;
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface FetchServiceOptions {
  maxBytesCap: number;
  timeoutMs: number;
  maxRedirects: number;
  /** テストでのみ差し替える。本番は常に既定値 */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  isBlockedAddress?: (address: string) => boolean;
  allowedPorts?: ReadonlySet<number>;
  /** User-Agent の既定値 (リクエストの user-agent ヘッダがあればそちらを使う) */
  userAgent?: string;
  /** false なら IPv6 の解決結果へは接続しない (拒否判定は IPv6 も含めて行う)。既定は true */
  allowIpv6?: boolean;
}

export interface FetchInput {
  url: string;
  maxBytes: number;
  headers: Record<string, string>;
}

export interface FetchResult {
  status: number;
  url: string;
  contentType: string | null;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
}

const DEFAULT_ALLOWED_PORTS: ReadonlySet<number> = new Set([80, 443]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORWARDED_REQUEST_HEADERS = new Set([
  'user-agent',
  'accept',
  'accept-language',
  'referer',
  'if-none-match',
  'if-modified-since',
]);
const MAX_HEADER_VALUE_LENGTH = 2048;
const MAX_URL_LENGTH = 2048;

export function sanitizeRequestHeaders(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase();
    if (!FORWARDED_REQUEST_HEADERS.has(key)) continue;
    if (typeof value !== 'string' || value.length > MAX_HEADER_VALUE_LENGTH || /[^\t\x20-\x7e\x80-\xff]/.test(value)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

async function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
}

function pinnedLookup(target: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      (callback as unknown as (err: null, addresses: ResolvedAddress[]) => void)(null, [target]);
    } else {
      callback(null, target.address, target.family);
    }
  };
}

function responseDecoder(encoding: string | undefined) {
  switch ((encoding ?? '').toLowerCase().trim()) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      return null;
  }
}

const KEPT_RESPONSE_HEADERS = ['content-type', 'etag', 'last-modified', 'retry-after', 'cf-mitigated'];

function pickResponseHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue;
    if (KEPT_RESPONSE_HEADERS.includes(name) || name.startsWith('cf-chl-')) out[name] = value;
  }
  return out;
}

export function createFetchService(options: FetchServiceOptions) {
  const resolve = options.resolve ?? defaultResolve;
  const blockedAddress = options.isBlockedAddress ?? isBlockedAddress;
  const allowedPorts = options.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  const allowIpv6 = options.allowIpv6 ?? true;

  /** URL を検査し、接続に使う検証済みアドレスを 1 つ返す (接続はそのアドレスへ固定する) */
  async function vet(url: URL): Promise<ResolvedAddress> {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchFailure('ssrf_blocked', 'scheme not allowed');
    if (url.username !== '' || url.password !== '') throw new FetchFailure('ssrf_blocked', 'userinfo not allowed');
    const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
    if (!allowedPorts.has(port)) throw new FetchFailure('ssrf_blocked', 'port not allowed');

    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    if (hostname === '') throw new FetchFailure('ssrf_blocked', 'empty host');
    if (isBlockedHostname(hostname)) throw new FetchFailure('ssrf_blocked', 'host not allowed');

    let addresses: ResolvedAddress[];
    if (isIP(hostname) !== 0) {
      addresses = [{ address: hostname, family: isIP(hostname) === 6 ? 6 : 4 }];
    } else {
      try {
        addresses = await resolve(hostname);
      } catch {
        throw new FetchFailure('network_error', 'dns resolution failed');
      }
    }
    if (addresses.length === 0) throw new FetchFailure('network_error', 'dns returned no addresses');
    // 1 つでも拒否対象を含む名前は使わない (解決結果の取捨選択で迂回されないように)。
    if (addresses.some((a) => blockedAddress(a.address))) throw new FetchFailure('ssrf_blocked', 'resolved address not allowed');
    // Cloud Run は既定で IPv6 で外に出られないので、A レコードがあれば優先する
    const usable = allowIpv6 ? addresses : addresses.filter((a) => a.family === 4);
    if (usable.length === 0) throw new FetchFailure('network_error', 'no usable address (ipv6 disabled)');
    return (usable.find((a) => a.family === 4) ?? usable[0]) as ResolvedAddress;
  }

  async function hop(
    url: URL,
    target: ResolvedAddress,
    headers: Record<string, string>,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }> {
    const isHttps = url.protocol === 'https:';
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    const lib = isHttps ? https : http;

    return new Promise((resolvePromise, reject) => {
      const req = lib.request(
        {
          method: 'GET',
          host: hostname,
          port: url.port === '' ? undefined : Number(url.port),
          path: `${url.pathname}${url.search}`,
          headers: { ...headers, 'accept-encoding': 'gzip, deflate, br', connection: 'close' },
          lookup: pinnedLookup(target),
          servername: isHttps && isIP(hostname) === 0 ? hostname : undefined,
          agent: false,
          signal,
          maxHeaderSize: 32 * 1024,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (REDIRECT_STATUSES.has(status)) {
            res.resume();
            resolvePromise({ status, headers: res.headers, body: Buffer.alloc(0), truncated: false });
            return;
          }
          const decoder = responseDecoder(res.headers['content-encoding']);
          const source = decoder ? res.pipe(decoder) : res;
          if (decoder) res.on('error', (err) => decoder.destroy(err));

          const chunks: Buffer[] = [];
          let total = 0;
          let truncated = false;
          source.on('data', (chunk: Buffer) => {
            if (truncated) return;
            const remaining = maxBytes - total;
            if (chunk.length > remaining) {
              if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
              total = maxBytes;
              truncated = true;
              res.destroy();
              source.destroy();
              resolvePromise({ status, headers: res.headers, body: Buffer.concat(chunks), truncated });
              return;
            }
            chunks.push(chunk);
            total += chunk.length;
          });
          source.on('end', () => {
            if (!truncated) resolvePromise({ status, headers: res.headers, body: Buffer.concat(chunks), truncated });
          });
          source.on('error', (err) => {
            if (!truncated) reject(err);
          });
          res.on('error', (err) => {
            if (!truncated) reject(err);
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  return async function fetchTarget(input: FetchInput): Promise<FetchResult> {
    if (input.url.length > MAX_URL_LENGTH) throw new FetchFailure('ssrf_blocked', 'url too long');
    const maxBytes = Math.min(input.maxBytes, options.maxBytesCap);
    const headers = {
      'user-agent': options.userAgent ?? 'utsuroi-gcp-http',
      ...sanitizeRequestHeaders(input.headers),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const deadline = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new FetchFailure('timeout', 'total timeout exceeded')), {
        once: true,
      });
    });
    deadline.catch(() => undefined);

    try {
      let current: URL;
      try {
        current = new URL(input.url);
      } catch {
        throw new FetchFailure('ssrf_blocked', 'invalid url');
      }

      for (let redirects = 0; ; redirects++) {
        const target = await Promise.race([vet(current), deadline]);
        let result;
        try {
          result = await Promise.race([hop(current, target, headers, maxBytes, controller.signal), deadline]);
        } catch (err) {
          if (err instanceof FetchFailure) throw err;
          if (controller.signal.aborted) throw new FetchFailure('timeout', 'total timeout exceeded');
          throw new FetchFailure('network_error', err instanceof Error ? err.message : 'request failed');
        }

        if (REDIRECT_STATUSES.has(result.status)) {
          const location = result.headers.location;
          if (typeof location !== 'string' || location === '') {
            throw new FetchFailure('network_error', `redirect status ${result.status} missing location`);
          }
          if (redirects >= options.maxRedirects) {
            throw new FetchFailure('network_error', `too_many_redirects: exceeded ${options.maxRedirects}`);
          }
          try {
            current = new URL(location, current);
          } catch {
            throw new FetchFailure('network_error', 'invalid redirect location');
          }
          continue;
        }

        const pickedHeaders = pickResponseHeaders(result.headers);
        return {
          status: result.status,
          url: current.toString(),
          contentType: pickedHeaders['content-type'] ?? null,
          headers: pickedHeaders,
          body: result.body,
          truncated: result.truncated,
        };
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}

export type FetchService = ReturnType<typeof createFetchService>;
