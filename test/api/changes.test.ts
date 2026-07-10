import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createSite, createSource, createMonitor, insertChangeIfNew } from '../../src/db';
import { authHeaders, buildTestApp, db, testEnv, uniqueName } from './helpers';

async function makeMonitor() {
  const site = await createSite(db(), { name: uniqueName('Change Site') });
  const source = await createSource(db(), { siteId: site.id, type: 'page', url: 'https://example.com/' });
  return createMonitor(db(), { siteId: site.id, sourceId: source.id, intervalSeconds: 3600 });
}

describe('GET /api/changes', () => {
  it('requires monitor_id query parameter (400)', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/changes', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(400);
  });

  it('lists changes for a monitor, most recent first', async () => {
    const { app } = buildTestApp();
    const monitor = await makeMonitor();
    await insertChangeIfNew(db(), {
      monitorId: monitor.id,
      targetUrl: 'https://example.com/',
      kind: 'updated',
      dedupeKey: 'hash-1',
      detectedAt: '2026-07-01T00:00:00.000Z',
    });
    await insertChangeIfNew(db(), {
      monitorId: monitor.id,
      targetUrl: 'https://example.com/',
      kind: 'updated',
      dedupeKey: 'hash-2',
      detectedAt: '2026-07-02T00:00:00.000Z',
    });

    const res = await app.request(`/api/changes?monitor_id=${monitor.id}`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.items).toHaveLength(2);
    expect(body.items[0].dedupe_key).toBe('hash-2');
  });

  it('GET /:id returns 404 for an unknown change', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/changes/nope', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
  });
});

describe('GET /api/changes/:id/diff', () => {
  it('returns the unified diff body from R2 as text/plain', async () => {
    const { app } = buildTestApp();
    const monitor = await makeMonitor();
    const diffText = '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n';
    const r2Key = `diffs/${uniqueName('diff')}.txt`;
    await env.BODIES.put(r2Key, diffText);

    const { row: change } = await insertChangeIfNew(db(), {
      monitorId: monitor.id,
      targetUrl: 'https://example.com/',
      kind: 'updated',
      dedupeKey: uniqueName('dedupe'),
      diffR2Key: r2Key,
    });

    const res = await app.request(`/api/changes/${change.id}/diff`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe(diffText);
  });

  it('returns 404 when the change has no diff stored', async () => {
    const { app } = buildTestApp();
    const monitor = await makeMonitor();
    const { row: change } = await insertChangeIfNew(db(), {
      monitorId: monitor.id,
      targetUrl: 'https://example.com/',
      kind: 'new',
      dedupeKey: uniqueName('dedupe-no-diff'),
    });

    const res = await app.request(`/api/changes/${change.id}/diff`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
  });

  it('returns 404 when the R2 object referenced by diff_r2_key is missing', async () => {
    const { app } = buildTestApp();
    const monitor = await makeMonitor();
    const { row: change } = await insertChangeIfNew(db(), {
      monitorId: monitor.id,
      targetUrl: 'https://example.com/',
      kind: 'new',
      dedupeKey: uniqueName('dedupe-missing-r2'),
      diffR2Key: 'diffs/does-not-exist.txt',
    });

    const res = await app.request(`/api/changes/${change.id}/diff`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
  });
});
