import type { DeliveryStatus } from '../shared/types';
import type { DeliveryRow, InsertResult } from './types';
import { newId, nowIso, wasWritten } from './util';

function mapRow(row: Record<string, unknown>): DeliveryRow {
  return {
    id: row.id as string,
    changeId: row.change_id as string,
    destinationId: row.destination_id as string,
    status: row.status as DeliveryStatus,
    attemptCount: row.attempt_count as number,
    lastError: (row.last_error as string | null) ?? null,
    deliveredAt: (row.delivered_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * 冪等な Delivery 作成。UNIQUE(change_id, destination_id) が ADR-0007 の冪等キー。
 * 同じ Change x Destination の組は 1 レコードのみ存在する。
 */
export async function createDeliveryIfNew(
  db: D1Database,
  changeId: string,
  destinationId: string
): Promise<InsertResult<DeliveryRow>> {
  const id = newId();
  const now = nowIso();
  const result = await db
    .prepare(
      `INSERT INTO deliveries (id, change_id, destination_id, status, attempt_count, last_error, delivered_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)
       ON CONFLICT(change_id, destination_id) DO NOTHING`
    )
    .bind(id, changeId, destinationId, now, now)
    .run();

  const inserted = wasWritten(result);
  if (inserted) {
    return {
      inserted: true,
      row: {
        id,
        changeId,
        destinationId,
        status: 'pending',
        attemptCount: 0,
        lastError: null,
        deliveredAt: null,
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  const existing = await db
    .prepare(`SELECT * FROM deliveries WHERE change_id = ? AND destination_id = ?`)
    .bind(changeId, destinationId)
    .first();
  if (!existing) throw new Error('createDeliveryIfNew: row vanished after conflict');
  return { inserted: false, row: mapRow(existing) };
}

export async function getDelivery(db: D1Database, id: string): Promise<DeliveryRow | null> {
  const row = await db.prepare(`SELECT * FROM deliveries WHERE id = ?`).bind(id).first();
  return row ? mapRow(row) : null;
}

export async function listDeliveriesByChange(db: D1Database, changeId: string): Promise<DeliveryRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM deliveries WHERE change_id = ? ORDER BY created_at ASC`)
    .bind(changeId)
    .all();
  return results.map(mapRow);
}

export async function markDeliveryDelivered(db: D1Database, id: string): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE deliveries SET status = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ?`
    )
    .bind(now, now, id)
    .run();
}

export async function markDeliveryFailed(
  db: D1Database,
  id: string,
  error: string,
  opts: { dead: boolean }
): Promise<void> {
  const now = nowIso();
  const status: DeliveryStatus = opts.dead ? 'dead' : 'failed';
  await db
    .prepare(
      `UPDATE deliveries
       SET status = ?, last_error = ?, attempt_count = attempt_count + 1, updated_at = ?
       WHERE id = ?`
    )
    .bind(status, error, now, id)
    .run();
}
