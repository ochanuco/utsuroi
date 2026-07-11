import { describe, expect, it } from 'vitest';
import { createExecutor, createFetcher, listAuditEventsBySubject } from '../../src/db';
import { authHeaders, buildTestApp, db, jsonHeaders, testEnv, uniqueName } from './helpers';

async function makeFetchers() {
  const executor = await createExecutor(db(), { kind: 'cloudflare', name: 'CF' });
  const httpId = uniqueName('cf-http');
  const browserId = uniqueName('home-browser');
  await createFetcher(db(), { id: httpId, executorId: executor.id, fetchMode: 'http' });
  await createFetcher(db(), { id: browserId, executorId: executor.id, fetchMode: 'browser' });
  return { httpId, browserId };
}

describe('POST/GET /api/sites', () => {
  it('creates a site and reads it back', async () => {
    const { app } = buildTestApp();
    const name = uniqueName('Example Site');

    const createRes = await app.request(
      '/api/sites',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name, canonical_origins: ['https://example.com'] }),
      },
      testEnv()
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as any;
    expect(created.name).toBe(name);
    expect(created.primary_origin).toBe('https://example.com');

    const getRes = await app.request(`/api/sites/${created.id}`, { headers: authHeaders() }, testEnv());
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json() as any;
    expect(fetched.id).toBe(created.id);
  });

  it('returns 404 for an unknown site id', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/sites/does-not-exist', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('site_not_found');
  });

  it('lists sites with limit/offset pagination', async () => {
    const { app } = buildTestApp();
    for (let i = 0; i < 3; i++) {
      await app.request(
        '/api/sites',
        { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: uniqueName('Page Site') }) },
        testEnv()
      );
    }
    const res = await app.request('/api/sites?limit=1&offset=0', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.items).toHaveLength(1);
    expect(body.total).toBeGreaterThanOrEqual(3);
  });

  it('rejects more than one canonical_origins entry instead of silently discarding the rest (400)', async () => {
    const { app } = buildTestApp();
    const res = await app.request(
      '/api/sites',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          name: uniqueName('Multi Origin Site'),
          canonical_origins: ['https://a.example.com', 'https://b.example.com'],
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('multiple_canonical_origins_unsupported');
  });

  it('rejects a non-JSON body', async () => {
    const { app } = buildTestApp();
    const res = await app.request(
      '/api/sites',
      { method: 'POST', headers: authHeaders({ 'content-type': 'text/plain' }), body: 'not json' },
      testEnv()
    );
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/sites/:id (rename)', () => {
  async function makeSite(app: ReturnType<typeof buildTestApp>['app'], name: string) {
    const res = await app.request(
      '/api/sites',
      { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name }) },
      testEnv()
    );
    // 作成に失敗していたら後続の PATCH テストが誤った前提で走るため、ここで確定させる。
    expect(res.status).toBe(201);
    const site = await res.json() as any;
    expect(site.id).toBeDefined();
    return site;
  }

  it('renames the site, reflects it on GET, and records a site.rename audit event', async () => {
    const { app } = buildTestApp();
    const oldName = uniqueName('Old Name');
    const newName = uniqueName('New Name');
    const site = await makeSite(app, oldName);

    const res = await app.request(
      `/api/sites/${site.id}`,
      { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ name: newName }) },
      testEnv()
    );
    expect(res.status).toBe(200);
    const updated = await res.json() as any;
    expect(updated.name).toBe(newName);

    const getRes = await app.request(`/api/sites/${site.id}`, { headers: authHeaders() }, testEnv());
    expect(((await getRes.json()) as any).name).toBe(newName);

    const audits = await listAuditEventsBySubject(db(), site.id);
    const rename = audits.find((a) => a.action === 'site.rename');
    expect(rename).toBeDefined();
    expect(rename?.payload).toEqual({ from: oldName, to: newName });
  });

  it('returns 404 for an unknown site id', async () => {
    const { app } = buildTestApp();
    const res = await app.request(
      '/api/sites/does-not-exist',
      { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ name: 'x' }) },
      testEnv()
    );
    expect(res.status).toBe(404);
  });

  it('rejects an empty or whitespace-only name (400) and keeps the original name', async () => {
    const { app } = buildTestApp();
    const originalName = uniqueName('Keep Name');
    const site = await makeSite(app, originalName);
    for (const name of ['', '   ']) {
      const res = await app.request(
        `/api/sites/${site.id}`,
        { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ name }) },
        testEnv()
      );
      expect(res.status).toBe(400);
    }
    const getRes = await app.request(`/api/sites/${site.id}`, { headers: authHeaders() }, testEnv());
    expect(((await getRes.json()) as any).name).toBe(originalName);
  });

  it('trims surrounding whitespace from a valid name before storing (zod .trim())', async () => {
    const { app } = buildTestApp();
    const site = await makeSite(app, uniqueName('Trim Me'));
    const trimmed = uniqueName('Trimmed');
    const res = await app.request(
      `/api/sites/${site.id}`,
      { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ name: `  ${trimmed}  ` }) },
      testEnv()
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).name).toBe(trimmed);
  });

  it('treats renaming to the same name as a no-op (200, no audit event)', async () => {
    const { app } = buildTestApp();
    const name = uniqueName('Same Name');
    const site = await makeSite(app, name);
    const res = await app.request(
      `/api/sites/${site.id}`,
      { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ name }) },
      testEnv()
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).name).toBe(name);
    const audits = await listAuditEventsBySubject(db(), site.id);
    expect(audits.filter((a) => a.action === 'site.rename')).toHaveLength(0);
  });
});

describe('PUT/GET /api/sites/:id/fetcher-policy', () => {
  it('accepts a valid policy and round-trips it', async () => {
    const { app } = buildTestApp();
    const { httpId, browserId } = await makeFetchers();
    const site = await (
      await app.request(
        '/api/sites',
        { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: uniqueName('Policy Site') }) },
        testEnv()
      )
    ).json() as any;

    const putRes = await app.request(
      `/api/sites/${site.id}/fetcher-policy`,
      {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({
          allow_list: [httpId, browserId],
          order_list: [{ fetcher_id: httpId }, { fetcher_id: browserId, proceed_on: ['timeout'] }],
        }),
      },
      testEnv()
    );
    expect(putRes.status).toBe(200);

    const getRes = await app.request(`/api/sites/${site.id}/fetcher-policy`, { headers: authHeaders() }, testEnv());
    expect(getRes.status).toBe(200);
    const policy = await getRes.json() as any;
    expect(policy.allow_list).toEqual([httpId, browserId]);
  });

  it('rejects a policy whose orderList does not match allowList membership (400)', async () => {
    const { app } = buildTestApp();
    const { httpId, browserId } = await makeFetchers();
    const site = await (
      await app.request(
        '/api/sites',
        { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: uniqueName('Invalid Policy Site') }) },
        testEnv()
      )
    ).json() as any;

    const res = await app.request(
      `/api/sites/${site.id}/fetcher-policy`,
      {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({
          allow_list: [httpId],
          order_list: [{ fetcher_id: httpId }, { fetcher_id: browserId }],
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_fetcher_policy');
  });

  it('rejects an empty allowList (400)', async () => {
    const { app } = buildTestApp();
    const site = await (
      await app.request(
        '/api/sites',
        { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: uniqueName('Empty Policy Site') }) },
        testEnv()
      )
    ).json() as any;

    const res = await app.request(
      `/api/sites/${site.id}/fetcher-policy`,
      { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ allow_list: [], order_list: [] }) },
      testEnv()
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when no policy has been configured yet', async () => {
    const { app } = buildTestApp();
    const site = await (
      await app.request(
        '/api/sites',
        { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: uniqueName('No Policy Site') }) },
        testEnv()
      )
    ).json() as any;

    const res = await app.request(`/api/sites/${site.id}/fetcher-policy`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/sites/:id (Site/Source/Monitor削除機能)', () => {
  it('returns 404 for an unknown site id', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/sites/nope', { method: 'DELETE', headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('site_not_found');
  });

  it('deletes a site with no sources and records an audit event', async () => {
    const { app } = buildTestApp();
    const created = await (
      await app.request(
        '/api/sites',
        { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: uniqueName('Delete Site') }) },
        testEnv()
      )
    ).json() as any;

    const deleteRes = await app.request(
      `/api/sites/${created.id}`,
      { method: 'DELETE', headers: authHeaders() },
      testEnv()
    );
    expect(deleteRes.status).toBe(200);

    const getRes = await app.request(`/api/sites/${created.id}`, { headers: authHeaders() }, testEnv());
    expect(getRes.status).toBe(404);

    const events = await listAuditEventsBySubject(db(), created.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'site.delete', actor: 'admin', subject: created.id });
  });

  it('rejects deletion with 409 site_has_sources when a source still references the site', async () => {
    const { app } = buildTestApp();
    const site = await (
      await app.request(
        '/api/sites',
        { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: uniqueName('Site With Source') }) },
        testEnv()
      )
    ).json() as any;
    await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ site_id: site.id, type: 'page', url: 'https://site-with-source.example/' }),
      },
      testEnv()
    );

    const res = await app.request(`/api/sites/${site.id}`, { method: 'DELETE', headers: authHeaders() }, testEnv());
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('site_has_sources');

    // still present since deletion was rejected
    const getRes = await app.request(`/api/sites/${site.id}`, { headers: authHeaders() }, testEnv());
    expect(getRes.status).toBe(200);
  });
});
