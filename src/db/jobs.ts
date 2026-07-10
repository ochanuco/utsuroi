import type { CheckJobStatus } from '../shared/types';
import type {
  CheckAttemptRow,
  CheckJobRow,
  CreateCheckAttemptInput,
  CreateCheckJobInput,
  InsertResult,
} from './types';
import { newId, nowIso, wasWritten } from './util';

function mapJobRow(row: Record<string, unknown>): CheckJobRow {
  return {
    id: row.id as string,
    monitorId: row.monitor_id as string,
    scheduledFor: row.scheduled_for as string,
    status: row.status as CheckJobStatus,
    trigger: row.trigger as CheckJobRow['trigger'],
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

function mapAttemptRow(row: Record<string, unknown>): CheckAttemptRow {
  return {
    id: row.id as string,
    checkJobId: row.check_job_id as string,
    targetId: row.target_id as string,
    fetcherId: row.fetcher_id as string,
    attemptIndex: row.attempt_index as number,
    outcome: row.outcome as CheckAttemptRow['outcome'],
    failureClass: (row.failure_class as CheckAttemptRow['failureClass']) ?? null,
    statusCode: (row.status_code as number | null) ?? null,
    durationMs: (row.duration_ms as number | null) ?? null,
    snapshotId: (row.snapshot_id as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

/**
 * 冪等な Check Job 作成。UNIQUE(monitor_id, scheduled_for) により同一Monitorの
 * 同一スケジュール起動は重複しない (SPEC §10, §17.7)。
 */
export async function createCheckJobIfNew(
  db: D1Database,
  input: CreateCheckJobInput
): Promise<InsertResult<CheckJobRow>> {
  const id = input.id ?? newId();
  const now = nowIso();
  const status: CheckJobStatus = input.status ?? 'pending';
  const trigger = input.trigger ?? 'scheduled';

  const result = await db
    .prepare(
      `INSERT INTO check_jobs (id, monitor_id, scheduled_for, status, trigger, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(monitor_id, scheduled_for) DO NOTHING`
    )
    .bind(id, input.monitorId, input.scheduledFor, status, trigger, now)
    .run();

  const inserted = wasWritten(result);
  if (inserted) {
    return {
      inserted: true,
      row: {
        id,
        monitorId: input.monitorId,
        scheduledFor: input.scheduledFor,
        status,
        trigger,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
      },
    };
  }

  const existing = await db
    .prepare(`SELECT * FROM check_jobs WHERE monitor_id = ? AND scheduled_for = ?`)
    .bind(input.monitorId, input.scheduledFor)
    .first();
  if (!existing) throw new Error('createCheckJobIfNew: row vanished after conflict');
  return { inserted: false, row: mapJobRow(existing) };
}

export async function getCheckJob(db: D1Database, id: string): Promise<CheckJobRow | null> {
  const row = await db.prepare(`SELECT * FROM check_jobs WHERE id = ?`).bind(id).first();
  return row ? mapJobRow(row) : null;
}

export async function listCheckJobsByMonitor(db: D1Database, monitorId: string): Promise<CheckJobRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM check_jobs WHERE monitor_id = ? ORDER BY scheduled_for DESC`)
    .bind(monitorId)
    .all();
  return results.map(mapJobRow);
}

export async function updateCheckJobStatus(
  db: D1Database,
  id: string,
  status: CheckJobStatus,
  opts: { startedAt?: string; finishedAt?: string } = {}
): Promise<void> {
  await db
    .prepare(
      `UPDATE check_jobs SET status = ?,
        started_at = COALESCE(?, started_at),
        finished_at = COALESCE(?, finished_at)
       WHERE id = ?`
    )
    .bind(status, opts.startedAt ?? null, opts.finishedAt ?? null, id)
    .run();
}

export async function createCheckAttempt(
  db: D1Database,
  input: CreateCheckAttemptInput
): Promise<CheckAttemptRow> {
  const id = input.id ?? newId();
  const now = nowIso();
  const startedAt = input.startedAt ?? now;
  await db
    .prepare(
      `INSERT INTO check_attempts
        (id, check_job_id, target_id, fetcher_id, attempt_index, outcome, failure_class, status_code, duration_ms, snapshot_id, error_message, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.checkJobId,
      input.targetId,
      input.fetcherId,
      input.attemptIndex,
      input.outcome,
      input.failureClass ?? null,
      input.statusCode ?? null,
      input.durationMs ?? null,
      input.snapshotId ?? null,
      input.errorMessage ?? null,
      startedAt,
      input.finishedAt ?? null,
      now
    )
    .run();
  return {
    id,
    checkJobId: input.checkJobId,
    targetId: input.targetId,
    fetcherId: input.fetcherId,
    attemptIndex: input.attemptIndex,
    outcome: input.outcome,
    failureClass: input.failureClass ?? null,
    statusCode: input.statusCode ?? null,
    durationMs: input.durationMs ?? null,
    snapshotId: input.snapshotId ?? null,
    errorMessage: input.errorMessage ?? null,
    startedAt,
    finishedAt: input.finishedAt ?? null,
    createdAt: now,
  };
}

export async function listCheckAttempts(db: D1Database, checkJobId: string): Promise<CheckAttemptRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM check_attempts WHERE check_job_id = ? ORDER BY attempt_index ASC`)
    .bind(checkJobId)
    .all();
  return results.map(mapAttemptRow);
}
