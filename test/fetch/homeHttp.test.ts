import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { crawlerStub } from '../../src/do/crawlerObject';
import { homeHttpFetch } from '../../src/fetch/homeHttp';
import type { FetcherInvocation } from '../../src/fetch/registry';
import { checkUrlForSsrf, type DnsResolver } from '../../src/net';
import type { Env } from '../../src/shared/env';
import { okRunnerResult, resetCrawler, startFakeRunner } from '../support/fakeRunner';

const publicResolver: DnsResolver = { resolve: async (_h, type) => (type === 'A' ? ['93.184.216.34'] : []) };

function invocation(over: Partial<FetcherInvocation> = {}): FetcherInvocation {
  return {
    url: 'https://example.com/feed.xml',
    userAgent: 'TestUA/1.0',
    etag: null,
    lastModified: null,
    env: env as unknown as Env,
    urlGuard: checkUrlForSsrf,
    ssrfResolver: publicResolver,
    ...over,
  };
}

async function withRunner<T>(
  handler: Parameters<typeof startFakeRunner>[0],
  fn: (runner: Awaited<ReturnType<typeof startFakeRunner>>) => Promise<T>,
): Promise<T> {
  const runner = await startFakeRunner(handler);
  try {
    return await fn(runner);
  } finally {
    await runner.stop();
  }
}

describe('homeHttpFetch', () => {
  beforeEach(() => resetCrawler());

  it('returns executor_unavailable immediately when no runner is online', async () => {
    const out = await homeHttpFetch(invocation());
    expect(out).toMatchObject({ ok: false, failureClass: 'executor_unavailable' });
  });

  it('classifies a 200 response and sends an allow-listed request', async () => {
    await withRunner(
      () => okRunnerResult(),
      async (runner) => {
        const jobRef: { executorJobId?: string } = {};
        const out = await homeHttpFetch(
          invocation({ etag: '"abc"', jobRef, headers: { cookie: 'secret=1', accept: 'text/html', authorization: 'Bearer x' } }),
        );
        expect(out).toMatchObject({ ok: true, status: 200 });
        const job = runner.seen[0]!;
        expect(jobRef.executorJobId).toBe(job.jobId);
        expect(job.request.url).toBe('https://example.com/feed.xml');
        expect(job.request.headers).toMatchObject({ 'user-agent': 'TestUA/1.0', 'if-none-match': '"abc"', accept: 'text/html' });
        expect(Object.keys(job.request.headers)).not.toContain('cookie');
        expect(Object.keys(job.request.headers)).not.toContain('authorization');
      },
    );
  });

  it.each([
    [304, true, null],
    [403, false, 'http_403'],
    [429, false, 'http_429'],
    [503, false, 'http_5xx'],
    [404, false, 'not_found'],
  ])('classifies upstream status %i', async (status, ok, failureClass) => {
    await withRunner(
      () => okRunnerResult({ status, body: '' }),
      async () => {
        const out = await homeHttpFetch(invocation());
        expect(out.ok).toBe(ok);
        if (!out.ok) expect(out.failureClass).toBe(failureClass);
      },
    );
  });

  it('maps a truncated 2xx response to too_large', async () => {
    await withRunner(
      () => okRunnerResult({ truncated: true }),
      async () => {
        expect(await homeHttpFetch(invocation())).toMatchObject({ ok: false, failureClass: 'too_large' });
      },
    );
  });

  it.each(['ssrf_blocked', 'timeout', 'network_error', 'too_large'] as const)('passes through runner error %s', async (failureClass) => {
    await withRunner(
      () => ({ kind: 'error', failureClass, message: 'x' }),
      async () => {
        expect(await homeHttpFetch(invocation())).toMatchObject({ ok: false, failureClass });
      },
    );
  });

  it('blocks a final URL that points into a private network', async () => {
    await withRunner(
      () => okRunnerResult({ url: 'http://192.168.0.1/admin' }),
      async () => {
        expect(await homeHttpFetch(invocation())).toMatchObject({ ok: false, failureClass: 'ssrf_blocked' });
      },
    );
  });

  it('does not enqueue when the source URL fails the static or DNS SSRF check', async () => {
    await withRunner(
      () => okRunnerResult(),
      async (runner) => {
        expect(await homeHttpFetch(invocation({ url: 'http://127.0.0.1/' }))).toMatchObject({ failureClass: 'ssrf_blocked' });
        const privateDns: DnsResolver = { resolve: async (_h, type) => (type === 'A' ? ['10.0.0.5'] : []) };
        expect(await homeHttpFetch(invocation({ ssrfResolver: privateDns }))).toMatchObject({ failureClass: 'ssrf_blocked' });
        expect(runner.seen).toHaveLength(0);
      },
    );
  });

  it('returns executor_unavailable when the runner leases but never answers', async () => {
    await withRunner(
      () => 'ignore',
      async () => {
        const out = await homeHttpFetch(invocation({ submitLimits: { resultWaitMs: 400 } }));
        expect(out).toMatchObject({ ok: false, failureClass: 'executor_unavailable' });
        // lease 後の期限切れの Runner は、次の接触までオフライン扱いで即失敗する
        const status = await crawlerStub(env as unknown as Env, 'home').status();
        expect(status.last1h.expired).toBeGreaterThanOrEqual(1);
      },
    );
  });

  it('returns executor_unavailable when nobody leases within the lease wait', async () => {
    await crawlerStub(env as unknown as Env, 'home').heartbeat({
      executorId: 'home',
      runnerId: 'idle',
      fetchModes: ['http'],
    });
    const out = await homeHttpFetch(invocation({ submitLimits: { leaseWaitMs: 300 } }));
    expect(out).toMatchObject({ ok: false, failureClass: 'executor_unavailable' });
  });
});
