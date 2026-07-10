import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createSite, createSource, createMonitor, upsertTarget, createSnapshot } from '../../src/db';
import { authHeaders, buildTestApp, db, testEnv, uniqueName } from './helpers';

async function makeTarget() {
  const site = await createSite(db(), { name: uniqueName('Snapshot Site') });
  const source = await createSource(db(), { siteId: site.id, type: 'page', url: 'https://example.com/' });
  const monitor = await createMonitor(db(), { siteId: site.id, sourceId: source.id, intervalSeconds: 3600 });
  const target = await upsertTarget(db(), { monitorId: monitor.id, url: 'https://example.com/' });
  return { monitor, target };
}

describe('GET /api/snapshots/:id', () => {
  it('requires auth (401)', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/snapshots/nope', {}, testEnv());
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown snapshot', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/snapshots/nope', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
  });

  it('returns snapshot metadata', async () => {
    const { app } = buildTestApp();
    const { monitor, target } = await makeTarget();
    const snapshot = await createSnapshot(db(), {
      monitorId: monitor.id,
      targetId: target.id,
      httpStatus: 200,
      contentType: 'text/html; charset=utf-8',
      etag: '"abc123"',
      lastModified: 'Wed, 01 Jul 2026 00:00:00 GMT',
      bodyHash: 'raw-hash',
      normalizedHash: 'normalized-hash',
      textHash: 'text-hash',
      normalizationVersion: 1,
      r2Key: `bodies/${uniqueName('raw')}.html`,
      normalizedR2Key: `bodies/${uniqueName('normalized')}.html`,
    });

    const res = await app.request(`/api/snapshots/${snapshot.id}`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({
      id: snapshot.id,
      monitor_id: monitor.id,
      target_id: target.id,
      http_status: 200,
      content_type: 'text/html; charset=utf-8',
      etag: '"abc123"',
      last_modified: 'Wed, 01 Jul 2026 00:00:00 GMT',
      body_hash: 'raw-hash',
      normalized_hash: 'normalized-hash',
      text_hash: 'text-hash',
      normalization_version: 1,
      has_body: true,
      has_normalized_body: true,
    });
    expect(body.fetched_at).toBeTruthy();
    expect(body.created_at).toBeTruthy();
    // R2 のキー自体は API から露出しない
    expect(body.r2_key).toBeUndefined();
    expect(body.normalized_r2_key).toBeUndefined();
  });

  it('reports has_body false when no raw body was stored', async () => {
    const { app } = buildTestApp();
    const { monitor, target } = await makeTarget();
    const snapshot = await createSnapshot(db(), {
      monitorId: monitor.id,
      targetId: target.id,
      httpStatus: 304,
    });

    const res = await app.request(`/api/snapshots/${snapshot.id}`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.has_body).toBe(false);
    expect(body.has_normalized_body).toBe(false);
  });
});

describe('GET /api/snapshots/:id/body', () => {
  it('requires auth (401)', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/snapshots/nope/body', {}, testEnv());
    expect(res.status).toBe(401);
  });

  it('returns the raw body from R2, always as text/plain with nosniff', async () => {
    const { app } = buildTestApp();
    const { monitor, target } = await makeTarget();
    const rawHtml = '<html><body><script>alert(1)</script></body></html>';
    const r2Key = `bodies/${uniqueName('raw')}.html`;
    await env.BODIES.put(r2Key, rawHtml);

    const snapshot = await createSnapshot(db(), {
      monitorId: monitor.id,
      targetId: target.id,
      httpStatus: 200,
      contentType: 'text/html; charset=utf-8',
      r2Key,
    });

    const res = await app.request(`/api/snapshots/${snapshot.id}/body`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
    // 保存されたコンテンツが text/html であっても、stored XSS を防ぐため常に text/plain 固定で返す
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-type')).toContain('charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(rawHtml);
  });

  it('returns 404 for an unknown snapshot', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/snapshots/nope/body', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
  });

  it('returns 404 when the snapshot has no r2Key stored', async () => {
    const { app } = buildTestApp();
    const { monitor, target } = await makeTarget();
    const snapshot = await createSnapshot(db(), {
      monitorId: monitor.id,
      targetId: target.id,
      httpStatus: 304,
    });

    const res = await app.request(`/api/snapshots/${snapshot.id}/body`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
  });

  it('returns 404 when the R2 object referenced by r2Key is missing', async () => {
    const { app } = buildTestApp();
    const { monitor, target } = await makeTarget();
    const snapshot = await createSnapshot(db(), {
      monitorId: monitor.id,
      targetId: target.id,
      httpStatus: 200,
      r2Key: 'bodies/does-not-exist.html',
    });

    const res = await app.request(`/api/snapshots/${snapshot.id}/body`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
  });
});
