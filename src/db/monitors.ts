import type { MonitorStatus } from '../shared/types';
import type { CreateMonitorInput, MonitorRow } from './types';
import { newId, nowIso } from './util';

function mapRow(row: Record<string, unknown>): MonitorRow {
  return {
    id: row.id as string,
    siteId: row.site_id as string,
    sourceId: row.source_id as string,
    status: row.status as MonitorStatus,
    stopReason: (row.stop_reason as string | null) ?? null,
    robotsEvaluationId: (row.robots_evaluation_id as string | null) ?? null,
    intervalSeconds: row.interval_seconds as number,
    nextRunAt: (row.next_run_at as string | null) ?? null,
    lastCheckedAt: (row.last_checked_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function createMonitor(db: D1Database, input: CreateMonitorInput): Promise<MonitorRow> {
  const id = input.id ?? newId();
  const now = nowIso();
  const status: MonitorStatus = input.status ?? 'active';
  const nextRunAt = input.nextRunAt ?? null;
  await db
    .prepare(
      `INSERT INTO monitors
        (id, site_id, source_id, status, stop_reason, robots_evaluation_id, interval_seconds, next_run_at, last_checked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)`
    )
    .bind(id, input.siteId, input.sourceId, status, input.intervalSeconds, nextRunAt, now, now)
    .run();
  return {
    id,
    siteId: input.siteId,
    sourceId: input.sourceId,
    status,
    stopReason: null,
    robotsEvaluationId: null,
    intervalSeconds: input.intervalSeconds,
    nextRunAt,
    lastCheckedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getMonitor(db: D1Database, id: string): Promise<MonitorRow | null> {
  const row = await db.prepare(`SELECT * FROM monitors WHERE id = ?`).bind(id).first();
  return row ? mapRow(row) : null;
}

export async function listMonitorsBySite(db: D1Database, siteId: string): Promise<MonitorRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM monitors WHERE site_id = ? ORDER BY created_at ASC`)
    .bind(siteId)
    .all();
  return results.map(mapRow);
}

export async function listMonitorsDue(db: D1Database, asOf: string): Promise<MonitorRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM monitors WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC`
    )
    .bind(asOf)
    .all();
  return results.map(mapRow);
}

/** 通常の状態更新 (active/paused/failing 等)。stop_reason/robots_evaluation_id はクリアされる */
export async function updateMonitorStatus(
  db: D1Database,
  id: string,
  status: MonitorStatus
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE monitors SET status = ?, stop_reason = NULL, robots_evaluation_id = NULL, updated_at = ? WHERE id = ?`
    )
    .bind(status, now, id)
    .run();
}

/** robots.txt 等による Policy Stop (SPEC §9, ADR-0008) */
export async function policyStopMonitor(
  db: D1Database,
  id: string,
  opts: { stopReason: string; robotsEvaluationId?: string | null }
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE monitors
       SET status = 'blocked_by_robots', stop_reason = ?, robots_evaluation_id = ?, next_run_at = NULL, updated_at = ?
       WHERE id = ?`
    )
    .bind(opts.stopReason, opts.robotsEvaluationId ?? null, now, id)
    .run();
}

export async function setMonitorNextRun(
  db: D1Database,
  id: string,
  nextRunAt: string | null
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(`UPDATE monitors SET next_run_at = ?, updated_at = ? WHERE id = ?`)
    .bind(nextRunAt, now, id)
    .run();
}

export async function setMonitorLastChecked(
  db: D1Database,
  id: string,
  lastCheckedAt: string
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(`UPDATE monitors SET last_checked_at = ?, updated_at = ? WHERE id = ?`)
    .bind(lastCheckedAt, now, id)
    .run();
}
