import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api';
import { authHeaders, jsonHeaders, testEnv } from './helpers';

const app = createApp();

describe('GET /api/fetchers', () => {
  it('requires auth', async () => {
    const res = await app.request('/api/fetchers', {}, testEnv());
    expect(res.status).toBe(401);
  });

  it('lists the seeded cf-http fetcher (migrations/0004)', async () => {
    const res = await app.request('/api/fetchers', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; fetch_mode: string }[]; total: number };
    const cfHttp = body.items.find((f) => f.id === 'cf-http');
    expect(cfHttp).toBeDefined();
    expect(cfHttp!.fetch_mode).toBe('http');
  });
});

describe('PUT /api/sites/:id/fetcher-policy with unknown fetcher', () => {
  it('returns 400 unknown_fetcher instead of a raw FK failure', async () => {
    const created = await app.request(
      '/api/sites',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: 'fetcher-master-check', canonical_origins: ['https://fm.example'] }),
      },
      testEnv()
    );
    expect(created.status).toBe(201);
    const site = (await created.json()) as { id: string };

    const res = await app.request(
      `/api/sites/${site.id}/fetcher-policy`,
      {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({
          allow_list: ['no-such-fetcher'],
          order_list: [{ fetcher_id: 'no-such-fetcher' }],
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('unknown_fetcher');
    expect(body.error.message).toContain('no-such-fetcher');
  });

  it('accepts the seeded cf-http without any manual fetcher setup', async () => {
    const created = await app.request(
      '/api/sites',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: 'fetcher-seed-ok', canonical_origins: ['https://fs.example'] }),
      },
      testEnv()
    );
    const site = (await created.json()) as { id: string };

    const res = await app.request(
      `/api/sites/${site.id}/fetcher-policy`,
      {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({
          allow_list: ['cf-http'],
          order_list: [{ fetcher_id: 'cf-http' }],
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(200);
  });
});
