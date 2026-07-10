import type { CreateSnapshotInput, SnapshotRow } from './types';
import { newId, nowIso } from './util';

function mapRow(row: Record<string, unknown>): SnapshotRow {
  return {
    id: row.id as string,
    monitorId: row.monitor_id as string,
    targetId: row.target_id as string,
    checkAttemptId: (row.check_attempt_id as string | null) ?? null,
    fetchedAt: row.fetched_at as string,
    httpStatus: (row.http_status as number | null) ?? null,
    contentType: (row.content_type as string | null) ?? null,
    etag: (row.etag as string | null) ?? null,
    lastModified: (row.last_modified as string | null) ?? null,
    bodyHash: (row.body_hash as string | null) ?? null,
    r2Key: (row.r2_key as string | null) ?? null,
    normalizedHash: (row.normalized_hash as string | null) ?? null,
    normalizedR2Key: (row.normalized_r2_key as string | null) ?? null,
    textHash: (row.text_hash as string | null) ?? null,
    normalizationVersion: (row.normalization_version as number | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export async function createSnapshot(db: D1Database, input: CreateSnapshotInput): Promise<SnapshotRow> {
  const id = input.id ?? newId();
  const now = nowIso();
  const fetchedAt = input.fetchedAt ?? now;
  await db
    .prepare(
      `INSERT INTO snapshots
        (id, monitor_id, target_id, check_attempt_id, fetched_at, http_status, content_type, etag, last_modified, body_hash, r2_key, normalized_hash, normalized_r2_key, text_hash, normalization_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.monitorId,
      input.targetId,
      input.checkAttemptId ?? null,
      fetchedAt,
      input.httpStatus ?? null,
      input.contentType ?? null,
      input.etag ?? null,
      input.lastModified ?? null,
      input.bodyHash ?? null,
      input.r2Key ?? null,
      input.normalizedHash ?? null,
      input.normalizedR2Key ?? null,
      input.textHash ?? null,
      input.normalizationVersion ?? null,
      now
    )
    .run();
  return {
    id,
    monitorId: input.monitorId,
    targetId: input.targetId,
    checkAttemptId: input.checkAttemptId ?? null,
    fetchedAt,
    httpStatus: input.httpStatus ?? null,
    contentType: input.contentType ?? null,
    etag: input.etag ?? null,
    lastModified: input.lastModified ?? null,
    bodyHash: input.bodyHash ?? null,
    r2Key: input.r2Key ?? null,
    normalizedHash: input.normalizedHash ?? null,
    normalizedR2Key: input.normalizedR2Key ?? null,
    textHash: input.textHash ?? null,
    normalizationVersion: input.normalizationVersion ?? null,
    createdAt: now,
  };
}

export async function getSnapshot(db: D1Database, id: string): Promise<SnapshotRow | null> {
  const row = await db.prepare(`SELECT * FROM snapshots WHERE id = ?`).bind(id).first();
  return row ? mapRow(row) : null;
}

/** Target の直近スナップショット (差分計算の基準にする) */
export async function getLatestSnapshotForTarget(
  db: D1Database,
  targetId: string
): Promise<SnapshotRow | null> {
  const row = await db
    .prepare(`SELECT * FROM snapshots WHERE target_id = ? ORDER BY fetched_at DESC, created_at DESC LIMIT 1`)
    .bind(targetId)
    .first();
  return row ? mapRow(row) : null;
}

export async function listSnapshotsByMonitor(db: D1Database, monitorId: string): Promise<SnapshotRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM snapshots WHERE monitor_id = ? ORDER BY fetched_at DESC`)
    .bind(monitorId)
    .all();
  return results.map(mapRow);
}
