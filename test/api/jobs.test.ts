import { describe, expect, it } from 'vitest';
import {
  createCheckAttempt,
  createCheckJobIfNew,
  createExecutor,
  createFetcher,
  createMonitor,
  createSite,
  createSource,
  upsertTarget,
} from '../../src/db';
import { authHeaders, buildTestApp, db, testEnv, uniqueName } from './helpers';

async function buildJobWithAttempts(attemptCount: number) {
  const d = db();
  const site = await createSite(d, { name: uniqueName('Job Site') });
  const source = await createSource(d, { siteId: site.id, type: 'page', url: 'https://example.com/' });
  const monitor = await createMonitor(d, { siteId: site.id, sourceId: source.id, intervalSeconds: 3600 });
  const target = await upsertTarget(d, { monitorId: monitor.id, url: 'https://example.com/' });
  const executor = await createExecutor(d, { kind: 'cloudflare', name: 'CF' });
  const fetcherId = uniqueName('fetcher');
  await createFetcher(d, { id: fetcherId, executorId: executor.id, fetchMode: 'http' });

  const job = await createCheckJobIfNew(d, { monitorId: monitor.id, scheduledFor: uniqueName('2026-07-10T00:00:00.000Z') });

  for (let i = 0; i < attemptCount; i++) {
    await createCheckAttempt(d, {
      checkJobId: job.row.id,
      targetId: target.id,
      fetcherId,
      attemptIndex: i,
      outcome: 'success',
      statusCode: 200,
    });
  }

  return job.row;
}

describe('GET /api/jobs/:id/attempts', () => {
  it('returns 404 for an unknown job id', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/jobs/does-not-exist/attempts', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('check_job_not_found');
  });

  it('paginates attempts at the DB level and reports the true total count', async () => {
    const { app } = buildTestApp();
    const job = await buildJobWithAttempts(7);

    const res = await app.request(`/api/jobs/${job.id}/attempts?limit=3&offset=0`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.items).toHaveLength(3);
    expect(body.total).toBe(7);

    const secondPageRes = await app.request(
      `/api/jobs/${job.id}/attempts?limit=3&offset=3`,
      { headers: authHeaders() },
      testEnv()
    );
    const secondPageBody = await secondPageRes.json() as any;
    expect(secondPageBody.items).toHaveLength(3);
    expect(secondPageBody.total).toBe(7);

    // every item within each page is unique, and the two pages are fully disjoint
    // (not just their first elements) -- guards against an ORDER BY without a unique
    // tie-breaker silently duplicating/skipping rows across pages.
    const firstIndices = new Set<number>(body.items.map((item: { attempt_index: number }) => item.attempt_index));
    const secondIndices = new Set<number>(
      secondPageBody.items.map((item: { attempt_index: number }) => item.attempt_index),
    );
    expect(firstIndices.size).toBe(3);
    expect(secondIndices.size).toBe(3);
    expect([...secondIndices].some((index) => firstIndices.has(index))).toBe(false);

    const thirdPageRes = await app.request(
      `/api/jobs/${job.id}/attempts?limit=3&offset=6`,
      { headers: authHeaders() },
      testEnv()
    );
    const thirdPageBody = await thirdPageRes.json() as any;
    expect(thirdPageBody.items).toHaveLength(1);
    const thirdIndices = new Set<number>(thirdPageBody.items.map((item: { attempt_index: number }) => item.attempt_index));

    const allIndices = new Set<number>([...firstIndices, ...secondIndices, ...thirdIndices]);
    expect(allIndices.size).toBe(7);
  });
});
