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

/** source配下にMonitorが存在するか (DELETE /api/sources/:id の409ガードに使う) */
export async function countMonitorsBySource(db: D1Database, sourceId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as count FROM monitors WHERE source_id = ?`)
    .bind(sourceId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Monitor削除 (関連する履歴も含めた完全カスケード)。D1 は FOREIGN KEY 制約を強制するため、
 * 子行を先に削除してから親 (monitors 本体) を消す必要がある (db.batch でトランザクションにまとめる)。
 *
 * migrations/0001_init.sql の FK 関係から、monitors を直接/間接に参照するテーブルは
 * targets / check_jobs / snapshots / changes / subscriptions であり、さらに:
 *  - check_attempts.check_job_id (NOT NULL) → check_jobs
 *  - check_attempts.target_id (NOT NULL) / snapshot_id (nullable) → targets / snapshots
 *  - snapshots.target_id (NOT NULL) → targets
 *  - snapshots.check_attempt_id (nullable) → check_attempts
 *  - changes.snapshot_id / previous_snapshot_id (nullable) → snapshots
 *  - deliveries.change_id (NOT NULL) → changes
 * という依存がある。ここで check_attempts.snapshot_id → snapshots と
 * snapshots.check_attempt_id → check_attempts は互いに (nullable) FK を持つ循環参照になっており、
 * 単純な子→親の順序付けでは解決できない (どちらを先に削除しても、他方がまだ参照していれば
 * FOREIGN KEY 制約違反になる: 実際にテストで検出した)。そのため削除前にこの循環を
 * 断ち切る UPDATE (snapshots.check_attempt_id を NULL 化) を先に行う。
 *
 * 実際の削除順:
 *   0. UPDATE snapshots SET check_attempt_id = NULL (循環参照を断つ)
 *   1. deliveries   (このmonitorのchangesに紐づくもの)
 *   2. check_attempts (このmonitorのcheck_jobsに紐づくもの)
 *   3. changes      (1. の後: deliveriesがchangesを参照するため)
 *   4. check_jobs   (2. の後: check_attemptsがcheck_jobsを参照するため)
 *   5. snapshots    (2., 3. の後: check_attempts/changesがsnapshotsを参照するため)
 *   6. targets      (2., 5. の後: check_attempts/snapshotsがtargetsを参照するため)
 *   7. subscriptions(monitor_id=)
 *   8. monitors 本体
 * となる。snapshots の削除は当初の設計メモには明記されていなかったが、
 * snapshots.monitor_id が NOT NULL FK であるため省略すると 8. で FK 違反になる。
 */
export async function deleteMonitorCascade(db: D1Database, monitorId: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare(`UPDATE snapshots SET check_attempt_id = NULL WHERE monitor_id = ?`).bind(monitorId),
    db
      .prepare(`DELETE FROM deliveries WHERE change_id IN (SELECT id FROM changes WHERE monitor_id = ?)`)
      .bind(monitorId),
    db
      .prepare(`DELETE FROM check_attempts WHERE check_job_id IN (SELECT id FROM check_jobs WHERE monitor_id = ?)`)
      .bind(monitorId),
    db.prepare(`DELETE FROM changes WHERE monitor_id = ?`).bind(monitorId),
    db.prepare(`DELETE FROM check_jobs WHERE monitor_id = ?`).bind(monitorId),
    db.prepare(`DELETE FROM snapshots WHERE monitor_id = ?`).bind(monitorId),
    db.prepare(`DELETE FROM targets WHERE monitor_id = ?`).bind(monitorId),
    db.prepare(`DELETE FROM subscriptions WHERE monitor_id = ?`).bind(monitorId),
    db.prepare(`DELETE FROM monitors WHERE id = ?`).bind(monitorId),
  ]);
  const monitorDeleteResult = results[results.length - 1];
  return (monitorDeleteResult?.meta?.changes ?? 0) > 0;
}
