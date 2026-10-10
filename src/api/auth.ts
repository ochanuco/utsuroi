/**
 * 全 /api/* に適用する Cloudflare Access JWT 検証ミドルウェア (ADR-0020, SPEC §15)。
 *
 * Access が付与する Cf-Access-Jwt-Assertion を Worker 自身で検証し、workers.dev や設定ミスで
 * Access を迂回されても API に到達できないようにする。検証に通った呼び出し元は
 * caller id (`user:<email>` / `token:<name>`) として Hono context に載せる。
 */
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../shared/env';

export interface AppEnv {
  Bindings: Env;
  Variables: { caller: string };
}

const JWT_HEADER = 'cf-access-jwt-assertion';
const CLOCK_SKEW_SECONDS = 60;
const JWKS_TTL_MS = 10 * 60 * 1000;
/** 未知 kid を理由にした再取得の最短間隔。偽 kid を連打されても JWKS エンドポイントを叩き続けない */
const JWKS_MIN_REFETCH_MS = 30 * 1000;
const TEAM_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

const RSA_IMPORT = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

class AuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface KeyCache {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
  teamDomain: string;
}

function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new AuthError(401, 'unauthorized', 'malformed token');
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  let bin: string;
  try {
    bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  } catch {
    throw new AuthError(401, 'unauthorized', 'malformed token');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parseJsonPart(part: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AuthError) throw err;
  }
  throw new AuthError(401, 'unauthorized', 'malformed token');
}

async function importJwks(body: unknown): Promise<Map<string, CryptoKey>> {
  const list = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) throw new Error('jwks: keys missing');
  const keys = new Map<string, CryptoKey>();
  for (const jwk of list as Array<Record<string, unknown>>) {
    if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    try {
      keys.set(
        jwk.kid,
        await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, RSA_IMPORT, false, ['verify']),
      );
    } catch {
      // 壊れた鍵は無視し、他の鍵だけを使う
    }
  }
  if (keys.size === 0) throw new Error('jwks: no usable RSA keys');
  return keys;
}

export interface AccessAuthOptions {
  /** JWKS 取得に使う fetch。省略時は globalThis.fetch。テストでスタブを注入する */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createAccessAuth(opts: AccessAuthOptions = {}): MiddlewareHandler<AppEnv> {
  let cache: KeyCache | null = null;
  let lastRefetchAt = 0;
  let inflight: Promise<KeyCache> | null = null;
  const now = opts.now ?? Date.now;

  async function refresh(teamDomain: string): Promise<KeyCache> {
    if (inflight) return inflight;
    inflight = (async () => {
      lastRefetchAt = now();
      // Workers の fetch は redirect: 'error' を受け付けない。manual にして 3xx も失敗として扱い、別ホストへ辿らない
      const res = await (opts.fetchImpl ?? fetch)(`https://${teamDomain}/cdn-cgi/access/certs`, { redirect: 'manual' });
      if (res.status !== 200) throw new Error(`jwks: http ${res.status}`);
      const keys = await importJwks(await res.json());
      cache = { keys, fetchedAt: now(), teamDomain };
      return cache;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function findKey(teamDomain: string, kid: string): Promise<CryptoKey> {
    try {
      let current = cache && cache.teamDomain === teamDomain ? cache : null;
      if (!current || now() - current.fetchedAt > JWKS_TTL_MS) current = await refresh(teamDomain);
      let key = current.keys.get(kid);
      if (!key && now() - lastRefetchAt >= JWKS_MIN_REFETCH_MS) key = (await refresh(teamDomain)).keys.get(kid);
      if (!key) throw new AuthError(401, 'unauthorized', 'unknown signing key');
      return key;
    } catch (err) {
      if (err instanceof AuthError) throw err;
      console.error('access auth: jwks unavailable', err instanceof Error ? err.message : err);
      throw new AuthError(503, 'auth_unavailable', 'authentication keys unavailable');
    }
  }

  async function verify(token: string, teamDomain: string, aud: string): Promise<Record<string, unknown>> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError(401, 'unauthorized', 'malformed token');
    const [h, p, s] = parts as [string, string, string];
    const header = parseJsonPart(h);
    if (header.alg !== 'RS256') throw new AuthError(401, 'unauthorized', 'unsupported algorithm');
    if (typeof header.kid !== 'string' || header.kid === '') throw new AuthError(401, 'unauthorized', 'missing key id');

    const key = await findKey(teamDomain, header.kid);
    const ok = await crypto.subtle.verify(RSA_IMPORT, key, base64UrlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) throw new AuthError(401, 'unauthorized', 'invalid signature');

    const claims = parseJsonPart(p);
    if (claims.iss !== `https://${teamDomain}`) throw new AuthError(401, 'unauthorized', 'invalid issuer');
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(aud)) throw new AuthError(401, 'unauthorized', 'invalid audience');
    const nowSec = now() / 1000;
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < nowSec) {
      throw new AuthError(401, 'unauthorized', 'token expired');
    }
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - CLOCK_SKEW_SECONDS > nowSec)) {
      throw new AuthError(401, 'unauthorized', 'token not yet valid');
    }
    return claims;
  }

  return async (c, next) => {
    const { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud } = c.env;
    if (!aud || !teamDomain || !TEAM_DOMAIN_RE.test(teamDomain)) {
      console.error('access auth: ACCESS_AUD / ACCESS_TEAM_DOMAIN is not configured; rejecting all /api requests');
      return c.json({ error: { code: 'auth_not_configured', message: 'authentication is not configured' } }, 503);
    }

    const token = c.req.header(JWT_HEADER);
    if (!token) return c.json({ error: { code: 'unauthorized', message: 'missing access token' } }, 401);

    try {
      const claims = await verify(token, teamDomain, aud);
      c.set('caller', resolveCaller(claims, c.env.ACCESS_CALLERS));
    } catch (err) {
      if (err instanceof AuthError) {
        return c.json({ error: { code: err.code, message: err.message } }, err.status);
      }
      throw err;
    }

    if (MUTATING_METHODS.has(c.req.method)) {
      console.log(JSON.stringify({ event: 'api_mutation', caller: c.get('caller'), method: c.req.method, path: c.req.path }));
    }
    await next();
  };
}

function parseCallers(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const v: unknown = JSON.parse(raw || '{}');
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      for (const [clientId, name] of Object.entries(v)) {
        if (typeof name === 'string' && name !== '') map.set(clientId, name);
      }
    }
  } catch {
    console.error('access auth: ACCESS_CALLERS is not valid JSON; treating as empty');
  }
  return map;
}

function resolveCaller(claims: Record<string, unknown>, rawCallers: string | undefined): string {
  if (typeof claims.email === 'string' && claims.email !== '') return `user:${claims.email}`;
  if (typeof claims.common_name === 'string' && claims.common_name !== '') {
    const name = parseCallers(rawCallers).get(claims.common_name);
    if (name) return `token:${name}`;
    throw new AuthError(403, 'forbidden', 'service token is not allowed');
  }
  throw new AuthError(401, 'unauthorized', 'token has no caller identity');
}
