import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCheckJobIfNew, getFetcher, getFetcherPolicy, listCheckAttempts, listCheckJobsByMonitor, putFetcherPolicy, upsertTarget } from '../../src/db';
import { fetchTargetThroughPolicy } from '../../src/pipeline/fetchTarget';
import { runMonitorCheck } from '../../src/pipeline/runCheck';
import type { CheckContext } from '../../src/pipeline/types';
import type { Env } from '../../src/shared/env';
import { okRunnerResult, resetCrawler, startFakeRunner } from '../support/fakeRunner';
import { buildPipelineFixture, db, fakeEnv, grantingLimiter, routedFetch } from './helpers';

const robots = { 'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }) };
const cfOk = (url: string) => ({ [url]: () => new Response('<html><body>from cf</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }) });

function checkEnv() {
  return fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] });
}

describe('home-http in the fetcher policy', () => {
  beforeEach(() => resetCrawler());

  it('is seeded by migration 0010', async () => {
    expect(await getFetcher(db(), 'home-http')).toMatchObject({ executorId: 'home', fetchMode: 'http', region: null });
    const row = await env.DB.prepare("SELECT kind, capabilities FROM executors WHERE id = 'home'").first<{ kind: string; capabilities: string }>();
    expect(row).toEqual({ kind: 'home_runner', capabilities: '{"fetch_modes":["http"]}' });
  });

  it('falls through to cf-http when no runner is online', async () => {
    const { monitor, site } = await buildPipelineFixture({ sourceUrl: 'https://example.com/page' });
    await putFetcherPolicy(db(), site.id, {
      allowList: ['home-http', 'cf-http'],
      orderList: [{ fetcherId: 'home-http' }, { fetcherId: 'cf-http' }],
    });
    const result = await runMonitorCheck(checkEnv(), monitor.id, {
      fetch: routedFetch({ ...robots, ...cfOk('https://example.com/page') }),
      hostLimiter: grantingLimiter(),
    });
    expect(result.kind).toBe('completed');
    const jobs = await listCheckJobsByMonitor(db(), monitor.id);
    const attempts = await listCheckAttempts(db(), jobs[0]!.id);
    expect(attempts.map((a) => [a.fetcherId, a.outcome, a.failureClass])).toEqual([
      ['home-http', 'failure', 'executor_unavailable'],
      ['cf-http', 'success', null],
    ]);
  });

  it('does not count executor_unavailable against the origin host (HostObject release)', async () => {
    const { monitor, site } = await buildPipelineFixture({ sourceUrl: 'https://example.com/only-home' });
    await putFetcherPolicy(db(), site.id, { allowList: ['home-http'], orderList: [{ fetcherId: 'home-http' }] });
    const releases: Array<{ leaseId: string; opts: unknown }> = [];
    await runMonitorCheck(checkEnv(), monitor.id, {
      fetch: routedFetch(robots),
      hostLimiter: grantingLimiter(releases),
    });
    expect(releases).toEqual([{ leaseId: expect.any(String), opts: { failureClass: 'executor_unavailable', retryAfterSeconds: null } }]);
  });

  it('builds a snapshot from the runner response and records executor_job_id', async () => {
    const { monitor, site } = await buildPipelineFixture({ sourceUrl: 'https://example.com/page' });
    await putFetcherPolicy(db(), site.id, {
      allowList: ['home-http', 'cf-http'],
      orderList: [{ fetcherId: 'home-http' }, { fetcherId: 'cf-http' }],
    });
    const runner = await startFakeRunner(() => okRunnerResult({ url: 'https://example.com/page' }));
    try {
      const result = await runMonitorCheck(checkEnv(), monitor.id, { fetch: routedFetch(robots), hostLimiter: grantingLimiter() });
      expect(result.kind).toBe('completed');
      const jobs = await listCheckJobsByMonitor(db(), monitor.id);
      const attempts = await listCheckAttempts(db(), jobs[0]!.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ fetcherId: 'home-http', outcome: 'success', executorJobId: runner.seen[0]!.jobId });
      const snapshot = await env.DB.prepare('SELECT check_attempt_id FROM snapshots WHERE monitor_id = ?').bind(monitor.id).first<{ check_attempt_id: string }>();
      expect(snapshot?.check_attempt_id).toBe(attempts[0]!.id);
    } finally {
      await runner.stop();
    }
  });

  it('stops submitting to an executor that was unavailable earlier in the same check', async () => {
    const { monitor, site, source } = await buildPipelineFixture({ sourceUrl: 'https://example.com/index.xml' });
    await putFetcherPolicy(db(), site.id, {
      allowList: ['home-http', 'cf-http'],
      orderList: [{ fetcherId: 'home-http' }, { fetcherId: 'cf-http' }],
    });
    const policy = (await getFetcherPolicy(db(), site.id))!;
    const job = (await createCheckJobIfNew(db(), { monitorId: monitor.id, scheduledFor: '2026-10-11T00:00:00.000Z' })).row;
    const target = await upsertTarget(db(), { monitorId: monitor.id, url: 'https://example.com/a' });
    const ctx: CheckContext = {
      env: checkEnv(),
      db: db(),
      monitor,
      source,
      site,
      policy,
      job,
      fetchImpl: routedFetch({ ...cfOk('https://example.com/a'), ...cfOk('https://example.com/b') }),
      now: () => Date.now(),
      changeIds: [],
    };

    // 1 回目: 実際に投入を試みて executor_unavailable になる
    await fetchTargetThroughPolicy(ctx, target.id, 'https://example.com/a', { etag: null, lastModified: null });
    expect(ctx.unavailableFetchers?.has('home-http')).toBe(true);

    // Runner が復帰しても、同じチェックの残りでは投入しない
    const runner = await startFakeRunner(() => okRunnerResult());
    try {
      await fetchTargetThroughPolicy(ctx, target.id, 'https://example.com/b', { etag: null, lastModified: null });
      expect(runner.seen).toHaveLength(0);
    } finally {
      await runner.stop();
    }
    const attempts = await listCheckAttempts(db(), job.id);
    const summary = attempts.map((a) => `${a.fetcherId}:${a.failureClass ?? 'ok'}`).sort();
    expect(summary).toEqual(['cf-http:ok', 'cf-http:ok', 'home-http:executor_unavailable', 'home-http:executor_unavailable']);
    expect(attempts.filter((a) => a.errorMessage?.includes('earlier in this check'))).toHaveLength(1);
  });
});
