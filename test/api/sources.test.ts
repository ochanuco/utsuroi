import { describe, expect, it } from 'vitest';
import { createSite } from '../../src/db';
import { authHeaders, buildTestApp, db, jsonHeaders, testEnv, uniqueName } from './helpers';

async function makeSite() {
  return createSite(db(), { name: uniqueName('Source Site') });
}

describe('POST /api/sources', () => {
  it('creates a source when the URL passes SSRF checks (public URL, stub resolver)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ site_id: site.id, type: 'page', url: 'https://example.com/page' }),
      },
      testEnv()
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.site_id).toBe(site.id);
    expect(body.url).toBe('https://example.com/page');
  });

  it('rejects a loopback URL literal at the static SSRF check (400)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ site_id: site.id, type: 'page', url: 'http://127.0.0.1/admin' }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('ssrf_blocked');
  });

  it('rejects a private-network URL literal (RFC1918) at the static SSRF check (400)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ site_id: site.id, type: 'rss', url: 'http://192.168.1.5/feed.xml' }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('ssrf_blocked');
  });

  it('returns 404 when site_id does not reference an existing site', async () => {
    const { app } = buildTestApp();
    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ site_id: 'nope', type: 'page', url: 'https://example.com/' }),
      },
      testEnv()
    );
    expect(res.status).toBe(404);
  });

  it('validates the source type enum (400)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();
    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ site_id: site.id, type: 'not-a-type', url: 'https://example.com/' }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/sources', () => {
  it('lists sources by site_id', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();
    await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ site_id: site.id, type: 'page', url: 'https://example.com/a' }),
      },
      testEnv()
    );

    const res = await app.request(`/api/sources?site_id=${site.id}`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.items).toHaveLength(1);
  });

  it('requires site_id query parameter (400)', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/sources', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(400);
  });
});
