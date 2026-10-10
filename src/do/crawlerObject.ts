/**
 * CrawlerObject: executor_id 単位の job 投入・lease・結果の受け渡し・Runner 生存管理 (ADR-0023, SPEC §11)。
 *
 * - job は SQLite に置く短命なデータで、結果の本文は永続化しない。受け取った結果は
 *   メモリ上で待機中の submitAndWait へ直接渡し、待機が無ければ捨てる。
 * - 1 つの job は一度だけ lease される。lease 応答が Runner に届かなかった job も再 lease せず、
 *   期限で expired になる (同じ URL の二重取得を避ける)。
 * - lease token は 32 byte 乱数で、SHA-256 だけを保存して定数時間で比較する。
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../shared/env';
import { MAX_LEASE_WAIT_MS, maxBase64Length, type LeasedJob, type RunnerResult } from '../runner/protocol';

export const RUNNER_ALIVE_WINDOW_MS = 60_000;
export const LEASE_WAIT_MS = 10_000;
export const RESULT_WAIT_MS = 40_000;
export const TERMINAL_RETENTION_MS = 60 * 60_000;
export const RUNNER_RETENTION_MS = 24 * 60 * 60_000;
const STATS_WINDOW_MS = 60 * 60_000;

export type UnavailableReason = 'runner_offline' | 'maintenance' | 'lease_timeout' | 'result_timeout';

export interface CrawlerJobInput {
  executorId: string;
  jobId: string;
  fetchMode: string;
  request: { url: string; maxBytes: number; headers: Record<string, string> };
}

export interface SubmitLimits {
  aliveWindowMs?: number;
  leaseWaitMs?: number;
  resultWaitMs?: number;
}

export type SubmitOutcome =
  | { kind: 'result'; jobId: string; result: RunnerResult }
  | { kind: 'unavailable'; jobId: string; reason: UnavailableReason };

export interface RunnerInfo {
  executorId: string;
  runnerId: string;
  version?: string;
  fetchModes: string[];
  concurrency?: number;
  inflight?: number;
}

export type CompleteOutcome =
  | 'accepted'
  | 'duplicate'
  | 'lease_mismatch'
  | 'lease_expired'
  | 'not_found'
  | 'too_large';

export interface CrawlerStatus {
  online: boolean;
  lastHeartbeatAt: string | null;
  runners: Array<{
    runnerId: string;
    version: string;
    concurrency: number;
    inflight: number;
    fetchModes: string[];
    lastSeenAt: string;
    online: boolean;
  }>;
  queued: number;
  last1h: { completed: number; expired: number; rejected: number };
}

type JobState = 'queued' | 'leased' | 'completed' | 'expired';

interface JobRow {
  [column: string]: SqlStorageValue;
  job_id: string;
  fetch_mode: string;
  payload: string;
  state: JobState;
  token_hash: string | null;
  runner_id: string | null;
  queue_deadline: number;
  result_wait_ms: number;
  lease_deadline: number | null;
}

interface RunnerRow {
  [column: string]: SqlStorageValue;
  runner_id: string;
  last_seen: number;
  version: string;
  fetch_modes: string;
  concurrency: number;
  inflight: number;
  offline: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 同じ長さの hex 文字列同士を定数時間で比較する */
function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseModes(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((m): m is string => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export class CrawlerObject extends DurableObject<Env> {
  /** テスト用の時刻注入。保存する時刻・生存判定に使う (待機タイマーは実時間) */
  nowOverride?: () => number;

  private waiters = new Map<string, (outcome: SubmitOutcome) => void>();
  private resultTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private queueTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private leaseWakers = new Set<() => void>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        fetch_mode TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL,
        token_hash TEXT,
        runner_id TEXT,
        created_at INTEGER NOT NULL,
        queue_deadline INTEGER NOT NULL,
        result_wait_ms INTEGER NOT NULL,
        lease_deadline INTEGER,
        terminal_at INTEGER
      )`);
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, created_at)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS runners (
        runner_id TEXT PRIMARY KEY,
        last_seen INTEGER NOT NULL,
        version TEXT NOT NULL,
        fetch_modes TEXT NOT NULL,
        concurrency INTEGER NOT NULL,
        inflight INTEGER NOT NULL,
        offline INTEGER NOT NULL DEFAULT 0
      )`);
      sql.exec(`CREATE TABLE IF NOT EXISTS events (ts INTEGER NOT NULL, kind TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    });
  }

  private now(): number {
    return this.nowOverride ? this.nowOverride() : Date.now();
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private async isMaintenance(executorId: string): Promise<boolean> {
    const row = await this.env.DB.prepare(`SELECT status FROM executors WHERE id = ?`).bind(executorId).first<{ status: string }>();
    return row?.status === 'maintenance';
  }

  private recordEvent(kind: 'completed' | 'expired' | 'rejected', now: number): void {
    this.sql.exec(`INSERT INTO events (ts, kind) VALUES (?, ?)`, now, kind);
  }

  private liveRunners(now: number, aliveWindowMs: number): RunnerRow[] {
    return this.sql
      .exec<RunnerRow>(`SELECT * FROM runners WHERE last_seen >= ? AND offline = 0`, now - aliveWindowMs)
      .toArray();
  }

  /** Runner の online/offline の遷移をログに残す (連続して同じ状態ならログしない) */
  private checkTransition(now: number): void {
    const online = this.liveRunners(now, RUNNER_ALIVE_WINDOW_MS).length > 0;
    const prev = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'online'`).toArray()[0]?.value;
    const next = online ? '1' : '0';
    if (prev === next) return;
    this.sql.exec(`INSERT INTO meta (key, value) VALUES ('online', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, next);
    if (prev === undefined && !online) return;
    log(online ? 'runner_online' : 'runner_offline', {});
  }

  private touchRunner(info: RunnerInfo, now: number): void {
    const modes = JSON.stringify(info.fetchModes);
    this.sql.exec(
      `INSERT INTO runners (runner_id, last_seen, version, fetch_modes, concurrency, inflight, offline)
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(runner_id) DO UPDATE SET
         last_seen = excluded.last_seen,
         offline = 0,
         fetch_modes = excluded.fetch_modes,
         version = CASE WHEN ? THEN excluded.version ELSE runners.version END,
         concurrency = CASE WHEN ? THEN excluded.concurrency ELSE runners.concurrency END,
         inflight = CASE WHEN ? THEN excluded.inflight ELSE runners.inflight END`,
      info.runnerId,
      now,
      info.version ?? '',
      modes,
      info.concurrency ?? 1,
      info.inflight ?? 0,
      info.version !== undefined ? 1 : 0,
      info.concurrency !== undefined ? 1 : 0,
      info.inflight !== undefined ? 1 : 0,
    );
    this.checkTransition(now);
  }

  private wakeLeasers(): void {
    for (const wake of [...this.leaseWakers]) wake();
  }

  private waitForJob(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.leaseWakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.leaseWakers.add(done);
    });
  }

  private clearTimers(jobId: string): void {
    const q = this.queueTimers.get(jobId);
    if (q) clearTimeout(q);
    this.queueTimers.delete(jobId);
    const r = this.resultTimers.get(jobId);
    if (r) clearTimeout(r);
    this.resultTimers.delete(jobId);
  }

  private resolveWaiter(jobId: string, outcome: SubmitOutcome): void {
    const waiter = this.waiters.get(jobId);
    if (!waiter) return;
    this.waiters.delete(jobId);
    waiter(outcome);
  }

  /** queued / leased の job を expired にして待機側へ unavailable を返す。既に終端なら何もしない */
  private expireJob(jobId: string, stage: 'lease' | 'result'): void {
    const now = this.now();
    const fromState: JobState = stage === 'lease' ? 'queued' : 'leased';
    const row = this.sql.exec<JobRow>(`SELECT * FROM jobs WHERE job_id = ? AND state = ?`, jobId, fromState).toArray()[0];
    if (!row) return;
    this.sql.exec(`UPDATE jobs SET state = 'expired', terminal_at = ? WHERE job_id = ?`, now, jobId);
    this.clearTimers(jobId);
    this.recordEvent('expired', now);
    if (stage === 'result' && row.runner_id) {
      // lease 後の期限切れが起きた Runner は、次に lease か heartbeat が届くまでオフラインとみなす
      this.sql.exec(`UPDATE runners SET offline = 1 WHERE runner_id = ?`, row.runner_id);
      this.checkTransition(now);
    }
    log('job_expired', { jobId, stage, runnerId: row.runner_id });
    this.resolveWaiter(jobId, { kind: 'unavailable', jobId, reason: stage === 'lease' ? 'lease_timeout' : 'result_timeout' });
    void this.scheduleAlarm();
  }

  async submitAndWait(input: CrawlerJobInput, limits: SubmitLimits = {}): Promise<SubmitOutcome> {
    const { jobId } = input;
    if (await this.isMaintenance(input.executorId)) {
      log('executor_unavailable', { jobId, reason: 'maintenance' });
      return { kind: 'unavailable', jobId, reason: 'maintenance' };
    }

    const now = this.now();
    const alive = this.liveRunners(now, limits.aliveWindowMs ?? RUNNER_ALIVE_WINDOW_MS).some((r) =>
      parseModes(r.fetch_modes).includes(input.fetchMode),
    );
    if (!alive) {
      log('executor_unavailable', { jobId, reason: 'runner_offline' });
      return { kind: 'unavailable', jobId, reason: 'runner_offline' };
    }

    const leaseWaitMs = limits.leaseWaitMs ?? LEASE_WAIT_MS;
    const resultWaitMs = limits.resultWaitMs ?? RESULT_WAIT_MS;
    this.sql.exec(
      `INSERT INTO jobs (job_id, fetch_mode, payload, state, created_at, queue_deadline, result_wait_ms)
       VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
      jobId,
      input.fetchMode,
      JSON.stringify(input.request),
      now,
      now + leaseWaitMs,
      resultWaitMs,
    );

    const outcome = new Promise<SubmitOutcome>((resolve) => {
      this.waiters.set(jobId, resolve);
    });
    this.queueTimers.set(
      jobId,
      setTimeout(() => this.expireJob(jobId, 'lease'), leaseWaitMs),
    );
    void this.scheduleAlarm();
    this.wakeLeasers();
    return outcome;
  }

  /** queued の job を最大 max 件 leased にする。lease 待ちの Promise を持つ job だけが対象 (DO リセット後の孤児は渡さない) */
  private async claim(info: RunnerInfo, max: number, fetchModes: string[]): Promise<LeasedJob[]> {
    if (fetchModes.length === 0) return [];
    const now = this.now();
    const placeholders = fetchModes.map(() => '?').join(',');
    const candidates = this.sql
      .exec<JobRow>(
        `SELECT * FROM jobs WHERE state = 'queued' AND fetch_mode IN (${placeholders}) ORDER BY created_at ASC`,
        ...fetchModes,
      )
      .toArray()
      .filter((j) => this.waiters.has(j.job_id))
      .slice(0, max);

    const claimed: Array<{ row: JobRow; token: string; expiresAt: number }> = [];
    for (const row of candidates) {
      const expiresAt = now + row.result_wait_ms;
      const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      // 状態遷移は同期的に済ませてから token のハッシュを計算する。この間 token はどこにも渡っていない
      this.sql.exec(
        `UPDATE jobs SET state = 'leased', runner_id = ?, lease_deadline = ? WHERE job_id = ? AND state = 'queued'`,
        info.runnerId,
        expiresAt,
        row.job_id,
      );
      const q = this.queueTimers.get(row.job_id);
      if (q) clearTimeout(q);
      this.queueTimers.delete(row.job_id);
      this.resultTimers.set(
        row.job_id,
        setTimeout(() => this.expireJob(row.job_id, 'result'), row.result_wait_ms),
      );
      claimed.push({ row, token, expiresAt });
    }

    const hashes = await Promise.all(claimed.map((c) => sha256Hex(c.token)));
    claimed.forEach((c, i) => {
      this.sql.exec(`UPDATE jobs SET token_hash = ? WHERE job_id = ?`, hashes[i], c.row.job_id);
    });
    if (claimed.length > 0) void this.scheduleAlarm();

    return claimed.map(({ row, token, expiresAt }) => {
      log('lease_issued', { jobId: row.job_id, runnerId: info.runnerId, fetchMode: row.fetch_mode });
      return {
        jobId: row.job_id,
        leaseToken: token,
        leaseExpiresAt: new Date(expiresAt).toISOString(),
        fetchMode: row.fetch_mode,
        request: JSON.parse(row.payload) as LeasedJob['request'],
      };
    });
  }

  async lease(info: RunnerInfo, max: number, waitMs: number): Promise<LeasedJob[]> {
    this.touchRunner(info, this.now());
    if (await this.isMaintenance(info.executorId)) return [];

    const deadline = Date.now() + Math.min(Math.max(waitMs, 0), MAX_LEASE_WAIT_MS);
    for (;;) {
      const jobs = await this.claim(info, max, info.fetchModes);
      if (jobs.length > 0) return jobs;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return [];
      await this.waitForJob(remaining);
    }
  }

  async heartbeat(info: RunnerInfo): Promise<{ maintenance: boolean }> {
    this.touchRunner(info, this.now());
    void this.scheduleAlarm();
    return { maintenance: await this.isMaintenance(info.executorId) };
  }

  async complete(jobId: string, leaseToken: string, result: RunnerResult): Promise<CompleteOutcome> {
    const presented = await sha256Hex(leaseToken);
    const now = this.now();
    const row = this.sql.exec<JobRow>(`SELECT * FROM jobs WHERE job_id = ?`, jobId).toArray()[0];
    if (!row) return 'not_found';

    if (row.token_hash === null || !equalHex(presented, row.token_hash)) {
      this.recordEvent('rejected', now);
      log('result_rejected', { jobId, reason: 'lease_mismatch' });
      return 'lease_mismatch';
    }
    if (row.state === 'completed') return 'duplicate';
    if (row.state !== 'leased') {
      this.recordEvent('rejected', now);
      log('result_rejected', { jobId, reason: 'lease_expired' });
      return 'lease_expired';
    }
    if (result.kind === 'response') {
      const { maxBytes } = JSON.parse(row.payload) as { maxBytes: number };
      if (result.body.length > maxBase64Length(maxBytes)) {
        this.recordEvent('rejected', now);
        log('result_rejected', { jobId, reason: 'too_large' });
        return 'too_large';
      }
    }

    this.sql.exec(`UPDATE jobs SET state = 'completed', terminal_at = ? WHERE job_id = ?`, now, jobId);
    this.clearTimers(jobId);
    this.recordEvent('completed', now);
    log('result_accepted', {
      jobId,
      fetchMode: row.fetch_mode,
      kind: result.kind,
      status: result.kind === 'response' ? result.status : null,
      durationMs: result.kind === 'response' ? result.durationMs : null,
    });
    this.resolveWaiter(jobId, { kind: 'result', jobId, result });
    void this.scheduleAlarm();
    return 'accepted';
  }

  async status(): Promise<CrawlerStatus> {
    const now = this.now();
    const runners = this.sql.exec<RunnerRow>(`SELECT * FROM runners ORDER BY runner_id`).toArray();
    const isLive = (r: RunnerRow) => r.offline === 0 && r.last_seen >= now - RUNNER_ALIVE_WINDOW_MS;
    const lastSeen = runners.reduce((m, r) => Math.max(m, r.last_seen), 0);
    const queued = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued'`).one().n;
    const counts = { completed: 0, expired: 0, rejected: 0 };
    for (const r of this.sql
      .exec<{ kind: keyof typeof counts; n: number }>(`SELECT kind, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY kind`, now - STATS_WINDOW_MS)
      .toArray()) {
      counts[r.kind] = r.n;
    }
    return {
      online: runners.some(isLive),
      lastHeartbeatAt: lastSeen > 0 ? new Date(lastSeen).toISOString() : null,
      runners: runners.map((r) => ({
        runnerId: r.runner_id,
        version: r.version,
        concurrency: r.concurrency,
        inflight: r.inflight,
        fetchModes: parseModes(r.fetch_modes),
        lastSeenAt: new Date(r.last_seen).toISOString(),
        online: isLive(r),
      })),
      queued,
      last1h: counts,
    };
  }

  private async scheduleAlarm(): Promise<void> {
    const q = this.sql.exec<{ t: number | null }>(`SELECT MIN(queue_deadline) AS t FROM jobs WHERE state = 'queued'`).one().t;
    const l = this.sql.exec<{ t: number | null }>(`SELECT MIN(lease_deadline) AS t FROM jobs WHERE state = 'leased'`).one().t;
    const term = this.sql.exec<{ t: number | null }>(`SELECT MIN(terminal_at) AS t FROM jobs WHERE terminal_at IS NOT NULL`).one().t;
    const run = this.sql.exec<{ t: number | null; m: number | null }>(`SELECT MIN(last_seen) AS t, MAX(last_seen) AS m FROM runners`).one();
    const candidates: number[] = [];
    if (q !== null) candidates.push(q);
    if (l !== null) candidates.push(l);
    if (term !== null) candidates.push(term + TERMINAL_RETENTION_MS);
    if (run.t !== null) candidates.push(run.t + RUNNER_RETENTION_MS);
    const markedOnline = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'online'`).toArray()[0]?.value === '1';
    if (run.m !== null && markedOnline) candidates.push(run.m + RUNNER_ALIVE_WINDOW_MS + 1);
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), Date.now() + 1000));
  }

  async alarm(): Promise<void> {
    const now = this.now();
    const lateQueued = this.sql
      .exec<{ job_id: string }>(`SELECT job_id FROM jobs WHERE state = 'queued' AND queue_deadline <= ?`, now)
      .toArray();
    for (const j of lateQueued) this.expireJob(j.job_id, 'lease');
    const lateLeased = this.sql
      .exec<{ job_id: string }>(`SELECT job_id FROM jobs WHERE state = 'leased' AND lease_deadline <= ?`, now)
      .toArray();
    for (const j of lateLeased) this.expireJob(j.job_id, 'result');

    this.sql.exec(`DELETE FROM jobs WHERE terminal_at IS NOT NULL AND terminal_at <= ?`, now - TERMINAL_RETENTION_MS);
    this.sql.exec(`DELETE FROM runners WHERE last_seen <= ?`, now - RUNNER_RETENTION_MS);
    this.sql.exec(`DELETE FROM events WHERE ts < ?`, now - STATS_WINDOW_MS);
    this.checkTransition(now);
    await this.scheduleAlarm();
  }
}
