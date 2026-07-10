import type { ChangeKind, DiffLevel } from '../shared/types';
import type { ChangeRow, CreateChangeInput, InsertResult } from './types';
import { newId, nowIso, wasWritten } from './util';

function mapRow(row: Record<string, unknown>): ChangeRow {
  return {
    id: row.id as string,
    monitorId: row.monitor_id as string,
    targetId: (row.target_id as string | null) ?? null,
    targetUrl: row.target_url as string,
    kind: row.kind as ChangeKind,
    diffLevel: (row.diff_level as DiffLevel | null) ?? null,
    dedupeKey: row.dedupe_key as string,
    previousSnapshotId: (row.previous_snapshot_id as string | null) ?? null,
    snapshotId: (row.snapshot_id as string | null) ?? null,
    diffR2Key: (row.diff_r2_key as string | null) ?? null,
    diffPreview: (row.diff_preview as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    detectedAt: row.detected_at as string,
    createdAt: row.created_at as string,
  };
}

/**
 * 冪等な Change 挿入。UNIQUE(monitor_id, dedupe_key) により、同一 Monitor に対する
 * 同一 dedupeKey (ページ変更なら content hash 由来、feed entry なら stable_key 由来) の
 * 重複挿入を防ぐ (SPEC §17.7-8)。
 */
export async function insertChangeIfNew(
  db: D1Database,
  input: CreateChangeInput
): Promise<InsertResult<ChangeRow>> {
  const id = input.id ?? newId();
  const now = nowIso();
  const detectedAt = input.detectedAt ?? now;

  const result = await db
    .prepare(
      `INSERT INTO changes
        (id, monitor_id, target_id, target_url, kind, diff_level, dedupe_key, previous_snapshot_id, snapshot_id, diff_r2_key, diff_preview, title, detected_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(monitor_id, dedupe_key) DO NOTHING`
    )
    .bind(
      id,
      input.monitorId,
      input.targetId ?? null,
      input.targetUrl,
      input.kind,
      input.diffLevel ?? null,
      input.dedupeKey,
      input.previousSnapshotId ?? null,
      input.snapshotId ?? null,
      input.diffR2Key ?? null,
      input.diffPreview ?? null,
      input.title ?? null,
      detectedAt,
      now
    )
    .run();

  const inserted = wasWritten(result);
  if (inserted) {
    return {
      inserted: true,
      row: {
        id,
        monitorId: input.monitorId,
        targetId: input.targetId ?? null,
        targetUrl: input.targetUrl,
        kind: input.kind,
        diffLevel: input.diffLevel ?? null,
        dedupeKey: input.dedupeKey,
        previousSnapshotId: input.previousSnapshotId ?? null,
        snapshotId: input.snapshotId ?? null,
        diffR2Key: input.diffR2Key ?? null,
        diffPreview: input.diffPreview ?? null,
        title: input.title ?? null,
        detectedAt,
        createdAt: now,
      },
    };
  }

  const existing = await db
    .prepare(`SELECT * FROM changes WHERE monitor_id = ? AND dedupe_key = ?`)
    .bind(input.monitorId, input.dedupeKey)
    .first();
  if (!existing) throw new Error('insertChangeIfNew: row vanished after conflict');
  return { inserted: false, row: mapRow(existing) };
}

export async function getChange(db: D1Database, id: string): Promise<ChangeRow | null> {
  const row = await db.prepare(`SELECT * FROM changes WHERE id = ?`).bind(id).first();
  return row ? mapRow(row) : null;
}

export async function listChangesByMonitor(db: D1Database, monitorId: string): Promise<ChangeRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM changes WHERE monitor_id = ? ORDER BY detected_at DESC`)
    .bind(monitorId)
    .all();
  return results.map(mapRow);
}
