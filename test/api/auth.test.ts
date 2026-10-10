import { describe, expect, it, vi } from 'vitest';
import {
  baseClaims,
  generateKeyPair,
  jwksFetch,
  jwksFor,
  signJwt,
  TEST_AUD,
  TEST_TEAM_DOMAIN,
} from './accessJwt';
import { authHeaders, buildTestApp, testEnv, testKeyPair, uniqueName } from './helpers';

const HEADER = 'cf-access-jwt-assertion';

async function call(token: string | null, env = testEnv(), method = 'GET', accessFetchImpl?: typeof fetch) {
  const { app } = buildTestApp({ accessFetchImpl });
  const headers: Record<string, string> = token === null ? {} : { [HEADER]: token };
  return app.request('/api/sites', { method, headers }, env);
}

describe('Access JWT auth (all /api/*)', () => {
  it('accepts a valid human JWT', async () => {
    const res = await call(await signJwt(testKeyPair, baseClaims({ email: 'a@example.com' })));
    expect(res.status).toBe(200);
  });

  it('accepts a string aud claim', async () => {
    const res = await call(await signJwt(testKeyPair, baseClaims({ email: 'a@example.com', aud: TEST_AUD })));
    expect(res.status).toBe(200);
  });

  it('accepts a mapped service token', async () => {
    const token = await signJwt(testKeyPair, baseClaims({ common_name: 'client-id-1.access' }));
    const res = await call(token, testEnv({ ACCESS_CALLERS: JSON.stringify({ 'client-id-1.access': 'runner' }) }));
    expect(res.status).toBe(200);
  });

  it('rejects an unmapped service token with 403', async () => {
    const token = await signJwt(testKeyPair, baseClaims({ common_name: 'other.access' }));
    const res = await call(token, testEnv({ ACCESS_CALLERS: JSON.stringify({ 'client-id-1.access': 'runner' }) }));
    expect(res.status).toBe(403);
  });

  it('does not resolve prototype keys as Client IDs', async () => {
    const token = await signJwt(testKeyPair, baseClaims({ common_name: 'constructor' }));
    expect((await call(token)).status).toBe(403);
  });

  it('treats invalid ACCESS_CALLERS as empty', async () => {
    const token = await signJwt(testKeyPair, baseClaims({ common_name: 'x' }));
    expect((await call(token, testEnv({ ACCESS_CALLERS: 'not json' }))).status).toBe(403);
  });

  it('rejects a JWT with neither email nor common_name', async () => {
    expect((await call(await signJwt(testKeyPair, baseClaims()))).status).toBe(401);
  });

  it('rejects a missing header with the standard error body', async () => {
    const res = await call(null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
  });

  it('rejects garbage tokens', async () => {
    expect((await call('not-a-jwt')).status).toBe(401);
    expect((await call('a.b.c')).status).toBe(401);
  });

  it('rejects a malformed signature segment with 401', async () => {
    const good = await signJwt(testKeyPair, baseClaims({ email: 'a@example.com' }));
    const [h, p] = good.split('.');
    expect((await call(`${h}.${p}.c`)).status).toBe(401);
    expect((await call(`${h}.${p}.!!`)).status).toBe(401);
    expect((await call(`${h}.${p}.`)).status).toBe(401);
  });

  it('rejects a bad signature', async () => {
    const other = await generateKeyPair();
    const token = await signJwt(other, baseClaims({ email: 'a@example.com' }));
    expect((await call(token)).status).toBe(401);
  });

  it('rejects a tampered payload', async () => {
    const good = await signJwt(testKeyPair, baseClaims({ email: 'a@example.com' }));
    const forged = await signJwt(testKeyPair, baseClaims({ email: 'admin@example.com' }));
    const token = `${forged.split('.')[0]}.${forged.split('.')[1]}.${good.split('.')[2]}`;
    expect((await call(token)).status).toBe(401);
  });

  it('rejects a wrong aud', async () => {
    const token = await signJwt(testKeyPair, baseClaims({ email: 'a@example.com', aud: ['someone-else'] }));
    expect((await call(token)).status).toBe(401);
  });

  it('rejects a wrong iss', async () => {
    const token = await signJwt(testKeyPair, baseClaims({ email: 'a@example.com', iss: 'https://evil.example.com' }));
    expect((await call(token)).status).toBe(401);
  });

  it('rejects an expired token but tolerates small clock skew', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await signJwt(testKeyPair, baseClaims({ email: 'a@example.com', exp: now - 600 }));
    expect((await call(expired)).status).toBe(401);
    const skewed = await signJwt(testKeyPair, baseClaims({ email: 'a@example.com', exp: now - 10 }));
    expect((await call(skewed)).status).toBe(200);
  });

  it('rejects a token without exp', async () => {
    const claims = baseClaims({ email: 'a@example.com' });
    delete claims.exp;
    expect((await call(await signJwt(testKeyPair, claims))).status).toBe(401);
  });

  it('rejects a token that is not yet valid (nbf)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(testKeyPair, baseClaims({ email: 'a@example.com', nbf: now + 600 }));
    expect((await call(token)).status).toBe(401);
  });

  it('rejects non-RS256 algorithms (alg none / HS256)', async () => {
    const claims = baseClaims({ email: 'a@example.com' });
    const none = await signJwt(testKeyPair, claims, { alg: 'none', signature: '' });
    expect((await call(none)).status).toBe(401);
    const hs = await signJwt(testKeyPair, claims, { alg: 'HS256' });
    expect((await call(hs)).status).toBe(401);
  });

  it('rejects an unknown kid', async () => {
    const token = await signJwt(testKeyPair, baseClaims({ email: 'a@example.com' }), { kid: 'unknown' });
    expect((await call(token)).status).toBe(401);
  });

  it('rejects all requests when ACCESS_AUD is empty (fail closed)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = await signJwt(testKeyPair, baseClaims({ email: 'a@example.com', aud: [''] }));
    const res = await call(token, testEnv({ ACCESS_AUD: '' }));
    expect(res.status).toBe(503);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('not configured'));
    spy.mockRestore();
  });

  it('returns 503 when the JWKS cannot be fetched', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    const token = await signJwt(testKeyPair, baseClaims({ email: 'a@example.com' }));
    expect((await call(token, testEnv(), 'GET', failing)).status).toBe(503);
    spy.mockRestore();
  });

  it('caches the JWKS and refetches once on an unknown kid', async () => {
    const calls: string[] = [];
    const rotated = await generateKeyPair();
    let jwks = await jwksFor(testKeyPair);
    const fetchImpl = (async (...args: Parameters<typeof fetch>) => jwksFetch(jwks, calls)(...args)) as typeof fetch;
    const { app } = buildTestApp({ accessFetchImpl: fetchImpl });
    const get = async (token: string) =>
      (await app.request('/api/sites', { headers: { [HEADER]: token } }, testEnv())).status;

    const t1 = await signJwt(testKeyPair, baseClaims({ email: 'a@example.com' }));
    expect(await get(t1)).toBe(200);
    expect(await get(t1)).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`https://${TEST_TEAM_DOMAIN}/cdn-cgi/access/certs`);

    // 鍵ローテーション直後の未知 kid は再取得で解決する (ただし最短間隔内の連続再取得はしない)
    jwks = await jwksFor(rotated, 'kid-2');
    const t2 = await signJwt(rotated, baseClaims({ email: 'a@example.com' }), { kid: 'kid-2' });
    expect(await get(t2)).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it('logs the caller id for mutating requests only', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app } = buildTestApp();
    await app.request('/api/sites', { headers: authHeaders() }, testEnv());
    expect(log).not.toHaveBeenCalled();
    await app.request(
      '/api/sites',
      { method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ name: uniqueName('s') }) },
      testEnv(),
    );
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('api_mutation'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      event: 'api_mutation',
      caller: 'user:tester@example.com',
      method: 'POST',
      path: '/api/sites',
    });
    log.mockRestore();
  });

  it('returns JSON 404 for unknown routes when authenticated', async () => {
    const { app } = buildTestApp();
    const res = await app.request(`/api/${uniqueName('nope')}`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe('not_found');
  });
});
