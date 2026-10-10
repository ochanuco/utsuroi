import { randomUUID } from 'node:crypto';
import { FetchFailure } from '../../shared/src/fetcher.ts';
import type { FetchService } from '../../shared/src/fetcher.ts';
import { AuthError } from './client.ts';
import type { RunnerClient } from './client.ts';
import { stdoutLogger } from './log.ts';
import type { Logger } from './log.ts';
import { FETCH_MODES, MAX_LEASE_WAIT_MS } from './protocol.ts';
import type { JobResult, LeasedJob } from './protocol.ts';

export interface RunnerOptions {
  client: Pick<RunnerClient, 'heartbeat' | 'lease' | 'sendResult'>;
  /** 与えられた時間 (ms) を総タイムアウトとする取得処理を作る */
  createFetchService: (timeoutMs: number) => FetchService;
  executorId: string;
  concurrency: number;
  version: string;
  fetchTimeoutMs: number;
  logger?: Logger;
  runnerId?: string;
  heartbeatIntervalMs?: number;
  leaseWaitMs?: number;
  /** 失敗後の再試行間隔の上限。401/403 は authBackoffMaxMs まで伸ばす */
  backoffMaxMs?: number;
  authBackoffMaxMs?: number;
  backoffBaseMs?: number;
  /** stop() が実行中 job の完了を待つ上限 */
  shutdownGraceMs?: number;
  now?: () => number;
}

const HEALTHY_WINDOW_MS = 60_000;
// lease の期限直前に取得を始めても結果を受け付けてもらえないため、結果送信の分を残す
const LEASE_SAFETY_MARGIN_MS = 3_000;

export class Runner {
  readonly runnerId: string;
  private readonly o: RunnerOptions;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly inflight = new Map<string, Promise<void>>();
  private stopping = false;
  private maintenance = false;
  private lastSuccessAt: number | null = null;
  private readonly leaseAbort = new AbortController();
  private readonly stopWake = new Set<() => void>();
  private readonly slotWake = new Set<() => void>();
  private loops: Promise<void>[] = [];
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: RunnerOptions) {
    this.o = options;
    this.runnerId = options.runnerId ?? randomUUID();
    this.log = options.logger ?? stdoutLogger;
    this.now = options.now ?? Date.now;
  }

  /** 直近 60 秒以内に Worker との lease か heartbeat が成功していれば true */
  isHealthy(): boolean {
    return this.lastSuccessAt !== null && this.now() - this.lastSuccessAt <= HEALTHY_WINDOW_MS;
  }

  start(): void {
    this.log('info', 'runner started', {
      runnerId: this.runnerId,
      executorId: this.o.executorId,
      concurrency: this.o.concurrency,
      version: this.o.version,
    });
    let firstHeartbeatDone!: () => void;
    const firstHeartbeat = new Promise<void>((resolve) => {
      firstHeartbeatDone = resolve;
    });
    this.loops = [this.heartbeatLoop(firstHeartbeatDone), this.leaseLoop(firstHeartbeat)];
  }

  /** 新規 lease を止め、実行中の job の結果を送ってから戻る */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log('info', 'runner stopping', { inflight: this.inflight.size });
    this.leaseAbort.abort();
    for (const fn of [...this.stopWake, ...this.slotWake]) fn();
    const grace = this.o.shutdownGraceMs ?? 30_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), grace);
    });
    const drained = (async () => {
      await Promise.allSettled(this.loops);
      while (this.inflight.size > 0) await Promise.allSettled([...this.inflight.values()]);
      return 'drained' as const;
    })();
    const outcome = await Promise.race([drained, timeout]);
    clearTimeout(timer);
    if (outcome === 'timeout') this.log('warn', 'shutdown grace exceeded', { inflight: this.inflight.size });
    else this.log('info', 'runner stopped');
  }

  private wakeLeaseLoop(): void {
    for (const fn of [...this.slotWake]) fn();
  }

  /** ms 待つ。stop() で早く戻る。onSlot なら空きスロットや maintenance 解除の通知でも戻る */
  private pause(ms: number, onSlot = false): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.stopWake.delete(done);
        this.slotWake.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.stopWake.add(done);
      if (onSlot) this.slotWake.add(done);
    });
  }

  private nextBackoff(current: number, auth: boolean): number {
    const base = this.o.backoffBaseMs ?? 1_000;
    const max = auth ? (this.o.authBackoffMaxMs ?? 300_000) : (this.o.backoffMaxMs ?? 30_000);
    return Math.min(current === 0 ? base : current * 2, max);
  }

  private reportFailure(what: string, err: unknown): boolean {
    const auth = err instanceof AuthError;
    if (auth) {
      this.log('error', 'authentication rejected; check CF_ACCESS_CLIENT_ID/SECRET and the Access policy', {
        what,
        status: (err as AuthError).status,
      });
    } else {
      this.log('warn', `${what} failed`, { error: err instanceof Error ? err.message : 'unknown' });
    }
    return auth;
  }

  private async heartbeatLoop(onFirstAttempt: () => void): Promise<void> {
    let backoff = 0;
    while (!this.stopping) {
      let wait = this.o.heartbeatIntervalMs ?? 15_000;
      try {
        const res = await this.o.client.heartbeat({
          executorId: this.o.executorId,
          runnerId: this.runnerId,
          version: this.o.version,
          fetchModes: FETCH_MODES,
          concurrency: this.o.concurrency,
          inflight: [...this.inflight.keys()],
        });
        if (res.maintenance !== this.maintenance) this.log('info', res.maintenance ? 'maintenance on' : 'maintenance off');
        this.maintenance = res.maintenance;
        this.lastSuccessAt = this.now();
        if (!res.maintenance) this.wakeLeaseLoop();
        backoff = 0;
      } catch (err) {
        const auth = this.reportFailure('heartbeat', err);
        backoff = this.nextBackoff(backoff, auth);
        wait = Math.max(wait, backoff);
      }
      onFirstAttempt();
      await this.pause(wait);
    }
    onFirstAttempt();
  }

  /** maintenance を知らないまま lease しないよう、最初の heartbeat の結果を待ってから始める */
  private async leaseLoop(firstHeartbeat: Promise<void>): Promise<void> {
    await firstHeartbeat;
    let backoff = 0;
    while (!this.stopping) {
      const free = this.o.concurrency - this.inflight.size;
      if (free <= 0 || this.maintenance) {
        await this.pause(5_000, true);
        continue;
      }
      try {
        const res = await this.o.client.lease(
          {
            executorId: this.o.executorId,
            runnerId: this.runnerId,
            max: free,
            waitMs: this.o.leaseWaitMs ?? MAX_LEASE_WAIT_MS,
            fetchModes: FETCH_MODES,
          },
          this.leaseAbort.signal,
        );
        this.lastSuccessAt = this.now();
        backoff = 0;
        for (const job of res.jobs.slice(0, free)) this.dispatch(job);
        if (res.jobs.length > free) this.log('warn', 'server returned more jobs than requested', { returned: res.jobs.length, max: free });
      } catch (err) {
        if (this.stopping) break;
        const auth = this.reportFailure('lease', err);
        backoff = this.nextBackoff(backoff, auth);
        await this.pause(backoff);
      }
    }
  }

  private dispatch(job: LeasedJob): void {
    this.log('info', 'job leased', { jobId: job.jobId, fetchMode: job.fetchMode, leaseExpiresAt: job.leaseExpiresAt });
    const task = this.execute(job)
      .catch((err: unknown) => {
        this.log('error', 'job failed', { jobId: job.jobId, error: err instanceof Error ? err.message : 'unknown' });
      })
      .finally(() => {
        this.inflight.delete(job.jobId);
        this.wakeLeaseLoop();
      });
    this.inflight.set(job.jobId, task);
  }

  private async execute(job: LeasedJob): Promise<void> {
    if (job.fetchMode !== 'http') {
      this.log('warn', 'unsupported fetch mode; job ignored', { jobId: job.jobId, fetchMode: job.fetchMode });
      return;
    }
    const remaining = Date.parse(job.leaseExpiresAt) - this.now() - LEASE_SAFETY_MARGIN_MS;
    if (!Number.isFinite(remaining) || remaining <= 0) {
      this.log('warn', 'lease too close to expiry; job skipped', { jobId: job.jobId });
      return;
    }

    const startedAt = this.now();
    let result: JobResult;
    try {
      const fetched = await this.o.createFetchService(Math.min(this.o.fetchTimeoutMs, remaining))(job.request);
      result = {
        kind: 'response',
        status: fetched.status,
        url: fetched.url,
        contentType: fetched.contentType,
        headers: fetched.headers,
        body: fetched.body.toString('base64'),
        truncated: fetched.truncated,
        durationMs: this.now() - startedAt,
      };
    } catch (err) {
      if (err instanceof FetchFailure) result = { kind: 'error', failureClass: err.failureClass, message: err.message };
      else result = { kind: 'error', failureClass: 'network_error', message: 'unexpected fetch error' };
    }
    this.log('info', 'fetch finished', {
      jobId: job.jobId,
      kind: result.kind,
      status: result.kind === 'response' ? result.status : undefined,
      failureClass: result.kind === 'error' ? result.failureClass : undefined,
      durationMs: this.now() - startedAt,
    });

    try {
      const outcome = await this.o.client.sendResult(job.jobId, { leaseToken: job.leaseToken, result });
      this.lastSuccessAt = this.now();
      if ('rejected' in outcome) this.log('warn', 'result rejected', { jobId: job.jobId, reason: outcome.rejected });
      else this.log('info', 'result accepted', { jobId: job.jobId, duplicate: outcome.duplicate === true });
    } catch (err) {
      this.reportFailure('result delivery', err);
    }
  }
}
