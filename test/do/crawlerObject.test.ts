import { env, runInDurableObject as runIn } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  RUNNER_ALIVE_WINDOW_MS,
  RUNNER_RETENTION_MS,
  TERMINAL_RETENTION_MS,
  type CrawlerJobInput,
  type CrawlerObject,
  type RunnerInfo,
} from '../../src/do/crawlerObject';
import type { RunnerResult } from '../../src/runner/protocol';

async function runInDurableObject<T>(
  stub: DurableObjectStub<CrawlerObject>,
  fn: (instance: CrawlerObject, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  return runIn(stub, (instance, state) => fn(instance as CrawlerObject, state as DurableObjectState));
}

let seq = 0;
function newExecutor(): { executorId: string; stub: DurableObjectStub<CrawlerObject> } {
  const executorId = `exec-${Date.now()}-${++seq}`;
  const stub = env.CRAWLER_DO.get(env.CRAWLER_DO.idFromName(executorId)) as unknown as DurableObjectStub<CrawlerObject>;
  return { executorId, stub };
}

function runner(executorId: string, over: Partial<RunnerInfo> = {}): RunnerInfo {
  return { executorId, runnerId: 'r1', version: 'v', fetchModes: ['http'], concurrency: 2, inflight: 0, ...over };
}

function job(executorId: string, over: Partial<CrawlerJobInput> = {}): CrawlerJobInput {
  return {
    executorId,
    jobId: crypto.randomUUID(),
    fetchMode: 'http',
    request: { url: 'https://example.com/feed.xml', maxBytes: 1024, headers: {} },
    ...over,
  };
}

const okResult = (body = 'PHJzcy8+'): RunnerResult => ({
  kind: 'response',
  status: 200,
  url: 'https://example.com/feed.xml',
  contentType: 'application/rss+xml',
  headers: {},
  body,
  truncated: false,
  durationMs: 5,
});

// 待機の上限は余裕をもって短く取る。判定は「上限が過ぎたら必ず unavailable になる」ことだけで、時間の精度には依存しない
const SHORT = { leaseWaitMs: 400, resultWaitMs: 400 };

async function setClock(stub: DurableObjectStub<CrawlerObject>, at: number | null): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    instance.nowOverride = at === null ? undefined : () => at;
  });
}

describe('CrawlerObject submitAndWait / lease / complete', () => {
  it('returns unavailable without calling any runner when no heartbeat has been seen', async () => {
    const { executorId, stub } = newExecutor();
    const out = await stub.submitAndWait(job(executorId));
    expect(out).toMatchObject({ kind: 'unavailable', reason: 'runner_offline' });
    expect((await stub.status()).queued).toBe(0);
  });

  it('returns unavailable when the last heartbeat is older than 60 seconds', async () => {
    const { executorId, stub } = newExecutor();
    const t0 = Date.now();
    await setClock(stub, t0);
    await stub.heartbeat(runner(executorId));
    await setClock(stub, t0 + RUNNER_ALIVE_WINDOW_MS + 1);
    const out = await stub.submitAndWait(job(executorId));
    expect(out).toMatchObject({ kind: 'unavailable', reason: 'runner_offline' });
  });

  it('returns unavailable while the executor is in maintenance', async () => {
    const { executorId, stub } = newExecutor();
    await env.DB.prepare(
      `INSERT INTO executors (id, kind, name, capabilities, status, created_at, updated_at) VALUES (?, 'home_runner', 'm', NULL, 'maintenance', 'x', 'x')`,
    )
      .bind(executorId)
      .run();
    expect(await stub.heartbeat(runner(executorId))).toEqual({ maintenance: true });
    const out = await stub.submitAndWait(job(executorId));
    expect(out).toMatchObject({ kind: 'unavailable', reason: 'maintenance' });
    expect(await stub.lease(runner(executorId), 1, 0)).toEqual([]);
  });

  it('hands a submitted job to a long-polling runner and passes its result to the waiter', async () => {
    const { executorId, stub } = newExecutor();
    await stub.heartbeat(runner(executorId));
    const leasing = stub.lease(runner(executorId), 2, 5_000);
    const input = job(executorId);
    const waiting = stub.submitAndWait(input);

    const leased = await leasing;
    expect(leased).toHaveLength(1);
    expect(leased[0]).toMatchObject({ jobId: input.jobId, fetchMode: 'http', request: input.request });
    expect(leased[0]!.leaseToken.length).toBeGreaterThanOrEqual(43);

    expect(await stub.complete(input.jobId, leased[0]!.leaseToken, okResult())).toBe('accepted');
    const out = await waiting;
    expect(out).toMatchObject({ kind: 'result', jobId: input.jobId });
    expect(out.kind === 'result' && out.result.kind === 'response' && out.result.status).toBe(200);
  });

  it('stores only the SHA-256 of the lease token and never the response body', async () => {
    const { executorId, stub } = newExecutor();
    await stub.heartbeat(runner(executorId));
    const input = job(executorId);
    const waiting = stub.submitAndWait(input);
    const [leased] = await stub.lease(runner(executorId), 1, 1_000);
    const marker = btoa('SECRET-BODY-MARKER');
    await stub.complete(input.jobId, leased!.leaseToken, okResult(marker));
    await waiting;

    const dump = await runInDurableObject(stub, (_i, state) => {
      const tables = ['jobs', 'runners', 'events', 'meta'];
      return JSON.stringify(tables.map((t) => state.storage.sql.exec(`SELECT * FROM ${t}`).toArray()));
    });
    expect(dump).not.toContain(marker);
    expect(dump).not.toContain('SECRET-BODY-MARKER');
    expect(dump).not.toContain(leased!.leaseToken);
  });

  it('expires a job nobody leases within the lease wait and fails the waiter', async () => {
    const { executorId, stub } = newExecutor();
    await stub.heartbeat(runner(executorId));
    const input = job(executorId);
    const out = await stub.submitAndWait(input, SHORT);
    expect(out).toMatchObject({ kind: 'unavailable', reason: 'lease_timeout' });
    // 期限切れの job は後から lease できない
    expect(await stub.lease(runner(executorId), 1, 0)).toEqual([]);
    expect((await stub.status()).last1h.expired).toBe(1);
    // lease 待ちの期限切れは Runner をオフラインにしない
    expect((await stub.status()).online).toBe(true);
  });

  it('expires a leased job after the result wait, rejects its late result, and marks the runner offline until next contact', async () => {
    const { executorId, stub } = newExecutor();
    await stub.heartbeat(runner(executorId));
    const input = job(executorId);
    const waiting = stub.submitAndWait(input, SHORT);
    const [leased] = await stub.lease(runner(executorId), 1, 1_000);
    const out = await waiting;
    expect(out).toMatchObject({ kind: 'unavailable', reason: 'result_timeout' });

    expect(await stub.complete(input.jobId, leased!.leaseToken, okResult())).toBe('lease_expired');

    expect((await stub.status()).online).toBe(false);
    expect(await stub.submitAndWait(job(executorId))).toMatchObject({ kind: 'unavailable', reason: 'runner_offline' });

    await stub.heartbeat(runner(executorId));
    expect((await stub.status()).online).toBe(true);
    const next = job(executorId);
    const pending = stub.submitAndWait(next, SHORT);
    expect(await pending).toMatchObject({ kind: 'unavailable', reason: 'lease_timeout' });
  });

  it('leases a job at most once even when several runners poll concurrently', async () => {
    const { executorId, stub } = newExecutor();
    await stub.heartbeat(runner(executorId));
    const input = job(executorId);
    const waiting = stub.submitAndWait(input, { leaseWaitMs: 5_000, resultWaitMs: 5_000 });
    const results = await Promise.all([
      stub.lease(runner(executorId, { runnerId: 'a' }), 1, 300),
      stub.lease(runner(executorId, { runnerId: 'b' }), 1, 300),
      stub.lease(runner(executorId, { runnerId: 'c' }), 1, 300),
    ]);
    const all = results.flat();
    expect(all).toHaveLength(1);
    await stub.complete(input.jobId, all[0]!.leaseToken, okResult());
    await waiting;
    // 完了後も再 lease されない
    expect(await stub.lease(runner(executorId), 1, 0)).toEqual([]);
  });

  it('never re-leases a job whose lease response was lost', async () => {
    const { executorId, stub } = newExecutor();
    await stub.heartbeat(runner(executorId));
    const waiting = stub.submitAndWait(job(executorId), { leaseWaitMs: 5_000, resultWaitMs: 400 });
    const first = await stub.lease(runner(executorId), 1, 1_000);
    expect(first).toHaveLength(1);
    expect(await stub.lease(runner(executorId), 1, 0)).toEqual([]);
    expect(await waiting).toMatchObject({ reason: 'result_timeout' });
    expect(await stub.lease(runner(executorId), 1, 0)).toEqual([]);
  });

  it('does not lease a job whose fetch mode the runner does not support', async () => {
    const { executorId, stub } = newExecutor();
    await stub.heartbeat(runner(executorId, { fetchModes: ['http', 'browser'] }));
    const waiting = stub.submitAndWait(job(executorId), SHORT);
    expect(await stub.lease(runner(executorId, { fetchModes: ['browser'] }), 1, 100)).toEqual([]);
    expect(await waiting).toMatchObject({ reason: 'lease_timeout' });
  });

  it('refuses to submit a job when no live runner supports its fetch mode', async () => {
    const { executorId, stub } = newExecutor();
    await stub.heartbeat(runner(executorId, { fetchModes: ['browser'] }));
    expect(await stub.submitAndWait(job(executorId, { fetchMode: 'http' }))).toMatchObject({ reason: 'runner_offline' });
  });

  it('complete: duplicate with the same token, mismatch with another, not_found for unknown jobs', async () => {
    const { executorId, stub } = newExecutor();
    await stub.heartbeat(runner(executorId));
    const input = job(executorId);
    const waiting = stub.submitAndWait(input);
    const [leased] = await stub.lease(runner(executorId), 1, 1_000);

    expect(await stub.complete(input.jobId, 'not-the-token', okResult())).toBe('lease_mismatch');
    expect(await stub.complete(input.jobId, leased!.leaseToken, okResult())).toBe('accepted');
    const out = await waiting;
    expect(await stub.complete(input.jobId, leased!.leaseToken, okResult('AAAA'))).toBe('duplicate');
    expect(await stub.complete(input.jobId, 'not-the-token', okResult())).toBe('lease_mismatch');
    expect(await stub.complete(crypto.randomUUID(), leased!.leaseToken, okResult())).toBe('not_found');
    // 再送の本文は待機側に渡らない (先に受理した結果が正)
    expect(out.kind === 'result' && out.result.kind === 'response' && out.result.body).toBe('PHJzcy8+');
    expect((await stub.status()).last1h.rejected).toBe(2);
  });

  it('rejects a result for a job that was never leased', async () => {
    const { executorId, stub } = newExecutor();
    await stub.heartbeat(runner(executorId));
    const input = job(executorId);
    const waiting = stub.submitAndWait(input, SHORT);
    expect(await stub.complete(input.jobId, '', okResult())).toBe('lease_mismatch');
    await waiting;
  });

  it('rejects a result body larger than the job maxBytes (base64) and leaves the job leased', async () => {
    const { executorId, stub } = newExecutor();
    await stub.heartbeat(runner(executorId));
    const input = job(executorId, { request: { url: 'https://example.com/', maxBytes: 3, headers: {} } });
    const waiting = stub.submitAndWait(input, { leaseWaitMs: 5_000, resultWaitMs: 5_000 });
    const [leased] = await stub.lease(runner(executorId), 1, 1_000);
    expect(await stub.complete(input.jobId, leased!.leaseToken, okResult('AAAAAAAA'))).toBe('too_large');
    expect(await stub.complete(input.jobId, leased!.leaseToken, okResult('AAAA'))).toBe('accepted');
    await waiting;
  });

  it('passes runner-reported error results through to the waiter', async () => {
    const { executorId, stub } = newExecutor();
    await stub.heartbeat(runner(executorId));
    const input = job(executorId);
    const waiting = stub.submitAndWait(input);
    const [leased] = await stub.lease(runner(executorId), 1, 1_000);
    await stub.complete(input.jobId, leased!.leaseToken, { kind: 'error', failureClass: 'ssrf_blocked', message: 'blocked' });
    expect(await waiting).toMatchObject({ kind: 'result', result: { kind: 'error', failureClass: 'ssrf_blocked' } });
  });
});

describe('CrawlerObject alarm / status', () => {
  it('reports runners and aggregates, and treats a runner as offline after 60 seconds', async () => {
    const { executorId, stub } = newExecutor();
    const t0 = Date.now();
    await setClock(stub, t0);
    await stub.heartbeat(runner(executorId, { version: 'abc', concurrency: 3, inflight: 1 }));
    let status = await stub.status();
    expect(status.online).toBe(true);
    expect(status.runners).toEqual([
      expect.objectContaining({ runnerId: 'r1', version: 'abc', concurrency: 3, inflight: 1, online: true }),
    ]);
    expect(status.lastHeartbeatAt).toBe(new Date(t0).toISOString());

    await setClock(stub, t0 + RUNNER_ALIVE_WINDOW_MS + 1);
    status = await stub.status();
    expect(status.online).toBe(false);
    expect(status.runners[0]!.online).toBe(false);
  });

  it('alarm deletes terminal jobs after 1 hour and silent runners after 24 hours', async () => {
    const { executorId, stub } = newExecutor();
    const t0 = Date.now();
    await setClock(stub, t0);
    await stub.heartbeat(runner(executorId));
    const input = job(executorId);
    const waiting = stub.submitAndWait(input, { leaseWaitMs: 5_000, resultWaitMs: 5_000 });
    const [leased] = await stub.lease(runner(executorId), 1, 1_000);
    await stub.complete(input.jobId, leased!.leaseToken, okResult());
    await waiting;

    const counts = () =>
      runInDurableObject(stub, (_i, state) => ({
        jobs: state.storage.sql.exec('SELECT COUNT(*) AS n FROM jobs').one().n as number,
        runners: state.storage.sql.exec('SELECT COUNT(*) AS n FROM runners').one().n as number,
      }));
    expect(await counts()).toEqual({ jobs: 1, runners: 1 });

    await setClock(stub, t0 + TERMINAL_RETENTION_MS + 1);
    await runInDurableObject(stub, (i) => i.alarm());
    expect(await counts()).toEqual({ jobs: 0, runners: 1 });
    expect((await stub.status()).last1h.completed).toBe(0);

    await setClock(stub, t0 + RUNNER_RETENTION_MS + 1);
    await runInDurableObject(stub, (i) => i.alarm());
    expect(await counts()).toEqual({ jobs: 0, runners: 0 });
  });

  it('alarm expires orphaned jobs whose waiter was lost (e.g. after a DO reset)', async () => {
    const { executorId, stub } = newExecutor();
    const t0 = Date.now();
    await setClock(stub, t0);
    await stub.heartbeat(runner(executorId));
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO jobs (job_id, fetch_mode, payload, state, created_at, queue_deadline, result_wait_ms) VALUES ('orphan-q', 'http', '{}', 'queued', ?, ?, 40000)`,
        t0,
        t0 + 10_000,
      );
      state.storage.sql.exec(
        `INSERT INTO jobs (job_id, fetch_mode, payload, state, token_hash, runner_id, created_at, queue_deadline, result_wait_ms, lease_deadline) VALUES ('orphan-l', 'http', '{}', 'leased', 'h', 'r1', ?, ?, 40000, ?)`,
        t0,
        t0 + 10_000,
        t0 + 40_000,
      );
    });
    // 孤児の queued job は待機側が居ないので lease しない
    expect(await stub.lease(runner(executorId), 1, 0)).toEqual([]);

    await setClock(stub, t0 + 41_000);
    await runInDurableObject(stub, (i) => i.alarm());
    const states = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec('SELECT job_id, state FROM jobs ORDER BY job_id').toArray(),
    );
    expect(states).toEqual([
      { job_id: 'orphan-l', state: 'expired' },
      { job_id: 'orphan-q', state: 'expired' },
    ]);
    expect((await stub.status()).runners[0]!.online).toBe(false);
  });
});
