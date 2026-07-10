import { describe, expect, it } from 'vitest';
import { authHeaders, buildTestApp, testEnv, uniqueName } from './helpers';

describe('bearer auth (all /api/*)', () => {
  it('rejects requests with no Authorization header', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/sites', {}, testEnv());
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
  });

  it('rejects requests with a wrong token', async () => {
    const { app } = buildTestApp();
    const res = await app.request(
      '/api/sites',
      { headers: { authorization: 'Bearer wrong-token' } },
      testEnv()
    );
    expect(res.status).toBe(401);
  });

  it('rejects all requests when ADMIN_TOKEN is unset', async () => {
    const { app } = buildTestApp();
    const res = await app.request(
      '/api/sites',
      { headers: authHeaders() },
      testEnv({ ADMIN_TOKEN: undefined })
    );
    expect(res.status).toBe(401);
  });

  it('allows requests with the correct bearer token', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/sites', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
  });

  it('accepts a case-insensitive "bearer" scheme (RFC 6750 scheme names are case-insensitive)', async () => {
    const { app } = buildTestApp();
    const res = await app.request(
      '/api/sites',
      { headers: { authorization: 'bearer test-token' } },
      testEnv()
    );
    expect(res.status).toBe(200);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const { app } = buildTestApp();
    const res = await app.request(
      `/api/${uniqueName('nope')}`,
      { headers: authHeaders() },
      testEnv()
    );
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('not_found');
  });
});
