import type { CreateTargetInput, TargetRow } from './types';
import { newId, nowIso, wasWritten } from './util';

function mapRow(row: Record<string, unknown>): TargetRow {
  return {
    id: row.id as string,
    monitorId: row.monitor_id as string,
    url: row.url as string,
    discoveredFrom: (row.discovered_from as string | null) ?? null,
    firstSeenAt: row.first_seen_at as string,
    lastCheckedAt: (row.last_checked_at as string | null) ?? null,
    lastKnownUpdatedAt: (row.last_known_updated_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * monitor_id + url が既存なら既存行を返し (冪等)、無ければ作成する。
 *
 * input.lastKnownUpdatedAt を渡した場合、新規作成時はその値を初期 watermark として保存し、
 * 既存行の場合も watermark を渡された値へ更新する (undefined の場合は既存値を保持し、上書きしない)。
 */
export async function upsertTarget(db: D1Database, input: CreateTargetInput): Promise<TargetRow> {
  const id = input.id ?? newId();
  const now = nowIso();
  const firstSeenAt = input.firstSeenAt ?? now;
  const initialWatermark = input.lastKnownUpdatedAt ?? null;
  const result = await db
    .prepare(
      `INSERT INTO targets (id, monitor_id, url, discovered_from, first_seen_at, last_checked_at, last_known_updated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(monitor_id, url) DO NOTHING`
    )
    .bind(id, input.monitorId, input.url, input.discoveredFrom ?? null, firstSeenAt, initialWatermark, now, now)
    .run();

  if (wasWritten(result)) {
    return {
      id,
      monitorId: input.monitorId,
      url: input.url,
      discoveredFrom: input.discoveredFrom ?? null,
      firstSeenAt,
      lastCheckedAt: null,
      lastKnownUpdatedAt: initialWatermark,
      createdAt: now,
      updatedAt: now,
    };
  }

  // 既存行: 呼び出し側が lastKnownUpdatedAt を明示的に渡した場合のみ watermark を更新する。
  // (渡さない = undefined の呼び出しは従来通りのプレーンな upsert として扱い、既存値を保持する)
  if (input.lastKnownUpdatedAt !== undefined) {
    await db
      .prepare(`UPDATE targets SET last_known_updated_at = ?, updated_at = ? WHERE monitor_id = ? AND url = ?`)
      .bind(input.lastKnownUpdatedAt, now, input.monitorId, input.url)
      .run();
  }

  const existing = await db
    .prepare(`SELECT * FROM targets WHERE monitor_id = ? AND url = ?`)
    .bind(input.monitorId, input.url)
    .first();
  if (!existing) throw new Error('upsertTarget: row vanished after conflict');
  return mapRow(existing);
}

export async function getTarget(db: D1Database, id: string): Promise<TargetRow | null> {
  const row = await db.prepare(`SELECT * FROM targets WHERE id = ?`).bind(id).first();
  return row ? mapRow(row) : null;
}

export async function listTargetsByMonitor(db: D1Database, monitorId: string): Promise<TargetRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM targets WHERE monitor_id = ? ORDER BY created_at ASC`)
    .bind(monitorId)
    .all();
  return results.map(mapRow);
}

export async function setTargetLastChecked(
  db: D1Database,
  id: string,
  lastCheckedAt: string
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(`UPDATE targets SET last_checked_at = ?, updated_at = ? WHERE id = ?`)
    .bind(lastCheckedAt, now, id)
    .run();
}

/**
 * Target の last_known_updated_at watermark を明示的に進める (migrations/0005)。
 * feed.ts の 'updated' Change 検出フローで、Change 挿入 + 通知ファンアウトの試行が完了した
 * *後にのみ* 呼ぶことを想定している — upsertTarget 呼び出し時点で無条件に進めてしまうと、
 * Change 挿入後・通知完了前にクラッシュしたケースの再試行が「既に処理済み」と誤認されて
 * at-least-once 復旧 (再度 insertChangeIfNew→notifyForChange を試す) が働かなくなるため。
 *
 * watermark は high-water mark (単調増加): 既存値より新しい場合にのみ更新する条件を SQL 側に
 * 入れている。無条件 UPDATE だと、並行実行 (手動 run と scheduled run の競合等) が read-check-
 * write の間に割り込んだ場合、古い値が新しい watermark を巻き戻しうるため (lost update)。
 * 既存値が NULL の場合は常に更新する。
 */
export async function setTargetLastKnownUpdatedAt(
  db: D1Database,
  id: string,
  lastKnownUpdatedAt: string
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE targets SET last_known_updated_at = ?, updated_at = ?
       WHERE id = ? AND (last_known_updated_at IS NULL OR last_known_updated_at < ?)`
    )
    .bind(lastKnownUpdatedAt, now, id, lastKnownUpdatedAt)
    .run();
}
