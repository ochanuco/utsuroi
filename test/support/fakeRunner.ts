import { env, runInDurableObject } from 'cloudflare:test';
import { crawlerStub } from '../../src/do/crawlerObject';
import type { LeasedJob, RunnerResult } from '../../src/runner/protocol';

export const okRunnerResult = (over: Record<string, unknown> = {}): RunnerResult =>
  ({
    kind: 'response',
    status: 200,
    url: 'https://example.com/feed.xml',
    contentType: 'text/html',
    headers: { 'content-type': 'text/html' },
    body: btoa('<html><body>ok</body></html>'),
    truncated: false,
    durationMs: 5,
    ...over,
  }) as RunnerResult;

/**
 * テスト内の偽 Runner。heartbeat 済みの状態で返り、lease した job を handler に渡して結果を返す。
 * handler が 'ignore' を返した job には結果を返さない (lease 後の期限切れの再現)。
 */
export async function startFakeRunner(
  handler: (job: LeasedJob) => RunnerResult | 'ignore',
  executorId = 'home',
) {
  const stub = crawlerStub(env as never, executorId);
  const info = { executorId, runnerId: 'fake-runner', version: 'test', fetchModes: ['http'], concurrency: 2, inflight: 0 };
  const seen: LeasedJob[] = [];
  let stopped = false;
  await stub.heartbeat(info);
  const loop = (async () => {
    while (!stopped) {
      const jobs = await stub.lease(info, 1, 300);
      for (const job of jobs) {
        seen.push(job);
        const result = handler(job);
        if (result !== 'ignore') await stub.complete(job.jobId, job.leaseToken, result);
      }
    }
  })();
  return {
    seen,
    async stop() {
      stopped = true;
      await loop;
    },
  };
}

/** テスト間で CrawlerObject の Runner・job の状態を持ち越さない (DO の永続状態はテストごとには戻らない) */
export async function resetCrawler(executorId = 'home'): Promise<void> {
  await runInDurableObject(crawlerStub(env as never, executorId), (_instance, state) => {
    for (const table of ['jobs', 'runners', 'events', 'meta']) state.storage.sql.exec(`DELETE FROM ${table}`);
  });
}
