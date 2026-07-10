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
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** monitor_id + url が既存なら既存行を返し (冪等)、無ければ作成する */
export async function upsertTarget(db: D1Database, input: CreateTargetInput): Promise<TargetRow> {
  const id = input.id ?? newId();
  const now = nowIso();
  const firstSeenAt = input.firstSeenAt ?? now;
  const result = await db
    .prepare(
      `INSERT INTO targets (id, monitor_id, url, discovered_from, first_seen_at, last_checked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(monitor_id, url) DO NOTHING`
    )
    .bind(id, input.monitorId, input.url, input.discoveredFrom ?? null, firstSeenAt, now, now)
    .run();

  if (wasWritten(result)) {
    return {
      id,
      monitorId: input.monitorId,
      url: input.url,
      discoveredFrom: input.discoveredFrom ?? null,
      firstSeenAt,
      lastCheckedAt: null,
      createdAt: now,
      updatedAt: now,
    };
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
