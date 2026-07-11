import { describe, expect, it } from 'vitest';
import { createSite, listAuditEventsBySubject } from '../../src/db';
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

// ADR-0010 Phase B: sitemap/sitemap-index Source の任意 config (sitemap_mode 等)。
describe('POST /api/sources: config (ADR-0010 Phase B sitemapMode)', () => {
  it('creates a sitemap-index source with a traverse config (201) and echoes it back snake_case', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'sitemap-index',
          url: 'https://example.com/sitemap-index.xml',
          config: { sitemap_mode: 'traverse', lastmod_max_age_days: 5, max_depth: 2 },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.config).toEqual({ sitemap_mode: 'traverse', lastmod_max_age_days: 5, max_depth: 2 });
  });

  it('rejects config for a page-type source (400 config_not_applicable)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'page',
          url: 'https://example.com/page',
          config: { sitemap_mode: 'traverse' },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('config_not_applicable');
  });

  it('rejects an invalid sitemap_mode enum value and out-of-range lastmod_max_age_days / max_depth (400)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const invalidConfigs = [
      { sitemap_mode: 'invalid' },
      { lastmod_max_age_days: 0 },
      { lastmod_max_age_days: 31 },
      { max_depth: 0 },
      { max_depth: 6 },
    ];

    for (const config of invalidConfigs) {
      const res = await app.request(
        '/api/sources',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            site_id: site.id,
            type: 'sitemap-index',
            url: `https://example.com/invalid-config-${JSON.stringify(config)}.xml`,
            config,
          }),
        },
        testEnv()
      );
      expect(res.status, `expected 400 for config ${JSON.stringify(config)}`).toBe(400);
    }
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

describe('DELETE /api/sources/:id (Site/Source/Monitor削除機能)', () => {
  it('returns 404 for an unknown source id', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/sources/nope', { method: 'DELETE', headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('source_not_found');
  });

  it('deletes a source with no monitors and records an audit event', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();
    const created = await (
      await app.request(
        '/api/sources',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ site_id: site.id, type: 'page', url: 'https://delete-source.example/' }),
        },
        testEnv()
      )
    ).json() as any;

    const deleteRes = await app.request(
      `/api/sources/${created.id}`,
      { method: 'DELETE', headers: authHeaders() },
      testEnv()
    );
    expect(deleteRes.status).toBe(200);

    const getRes = await app.request(`/api/sources/${created.id}`, { headers: authHeaders() }, testEnv());
    expect(getRes.status).toBe(404);

    const events = await listAuditEventsBySubject(db(), created.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'source.delete', actor: 'admin', subject: created.id });
  });

  it('rejects deletion with 409 source_has_monitors when a monitor still references the source', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();
    const source = await (
      await app.request(
        '/api/sources',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ site_id: site.id, type: 'page', url: 'https://has-monitor.example/' }),
        },
        testEnv()
      )
    ).json() as any;
    await app.request(
      '/api/monitors',
      { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ source_id: source.id, interval_seconds: 60 }) },
      testEnv()
    );

    const res = await app.request(
      `/api/sources/${source.id}`,
      { method: 'DELETE', headers: authHeaders() },
      testEnv()
    );
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('source_has_monitors');

    // still present since deletion was rejected
    const getRes = await app.request(`/api/sources/${source.id}`, { headers: authHeaders() }, testEnv());
    expect(getRes.status).toBe(200);
  });
});
