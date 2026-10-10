import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { RUNNER_ALIVE_WINDOW_MS, crawlerStub, type CrawlerObject } from '../../src/do/crawlerObject';
import { createExecutor } from '../../src/db';
import { authHeaders, buildTestApp, testEnv } from './helpers';

const { app } = buildTestApp();

async function homeExecutor(): Promise<string> {
  const id = `home-status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await createExecutor(env.DB, { id, kind: 'home_runner', name: 'Home Runner', capabilities: { fetch_modes: ['http'] } });
  return id;
}

async function get(path: string) {
  return app.request(path, { headers: authHeaders() }, testEnv());
}

describe('GET /api/executors', () => {
  it('requires auth', async () => {
    expect((await app.request('/api/executors', {}, testEnv())).status).toBe(401);
  });

  it('does not report online for non-home_runner executors', async () => {
    const res = await get('/api/executors/gcp');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: 'gcp', kind: 'cloud_run', status: 'active', capabilities: { fetch_modes: ['http'] } });
    expect(body).not.toHaveProperty('online');
    expect(body).not.toHaveProperty('runners');
  });

  it('reports online right after a heartbeat and offline after 60 seconds', async () => {
    const id = await homeExecutor();
    const stub = crawlerStub(env, id);
    const t0 = Date.now();
    await runInDurableObject(stub, (instance) => {
      (instance as CrawlerObject).nowOverride = () => t0;
    });
    await stub.heartbeat({ executorId: id, runnerId: 'r1', version: 'abc', fetchModes: ['http'], concurrency: 2, inflight: 1 });

    let body = (await (await get(`/api/executors/${id}`)).json()) as Record<string, any>;
    expect(body.online).toBe(true);
    expect(body.last_heartbeat_at).toBe(new Date(t0).toISOString());
    expect(body.runners).toEqual([
      expect.objectContaining({ runner_id: 'r1', version: 'abc', concurrency: 2, inflight: 1, online: true }),
    ]);
    expect(body.queued).toBe(0);
    expect(body.last_1h).toEqual({ completed: 0, expired: 0, rejected: 0 });

    await runInDurableObject(stub, (instance) => {
      (instance as CrawlerObject).nowOverride = () => t0 + RUNNER_ALIVE_WINDOW_MS + 1000;
    });
    body = (await (await get(`/api/executors/${id}`)).json()) as Record<string, any>;
    expect(body.online).toBe(false);
  });

  it('lists every executor with the home_runner status merged in', async () => {
    const id = await homeExecutor();
    const body = (await (await get('/api/executors')).json()) as { items: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(body.items.length);
    expect(body.items.find((e) => e.id === 'gcp')).not.toHaveProperty('online');
    expect(body.items.find((e) => e.id === id)).toMatchObject({ online: false, last_heartbeat_at: null, queued: 0 });
  });

  it('returns 404 for an unknown executor', async () => {
    expect((await get('/api/executors/nope')).status).toBe(404);
  });
});
