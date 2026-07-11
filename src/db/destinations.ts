import type { ChangeKind } from '../shared/types';
import type {
  CreateDestinationInput,
  CreateSubscriptionInput,
  DestinationRow,
  SubscriptionRow,
} from './types';
import { fromBool, newId, nowIso, toBool } from './util';

function mapDestinationRow(row: Record<string, unknown>): DestinationRow {
  return {
    id: row.id as string,
    name: row.name as string,
    webhookUrl: row.webhook_url as string,
    enabled: toBool(row.enabled as number),
    archivedAt: (row.archived_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapSubscriptionRow(row: Record<string, unknown>): SubscriptionRow {
  return {
    id: row.id as string,
    destinationId: row.destination_id as string,
    siteId: (row.site_id as string | null) ?? null,
    monitorId: (row.monitor_id as string | null) ?? null,
    tag: (row.tag as string | null) ?? null,
    changeKind: (row.change_kind as ChangeKind | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function createDestination(
  db: D1Database,
  input: CreateDestinationInput
): Promise<DestinationRow> {
  const id = input.id ?? newId();
  const now = nowIso();
  const enabled = input.enabled ?? true;
  await db
    .prepare(
      `INSERT INTO destinations (id, name, webhook_url, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, input.name, input.webhookUrl, fromBool(enabled), now, now)
    .run();
  return { id, name: input.name, webhookUrl: input.webhookUrl, enabled, archivedAt: null, createdAt: now, updatedAt: now };
}

export async function getDestination(db: D1Database, id: string): Promise<DestinationRow | null> {
  const row = await db.prepare(`SELECT * FROM destinations WHERE id = ?`).bind(id).first();
  return row ? mapDestinationRow(row) : null;
}

export async function listDestinations(db: D1Database): Promise<DestinationRow[]> {
  const { results } = await db.prepare(`SELECT * FROM destinations ORDER BY created_at ASC`).all();
  return results.map(mapDestinationRow);
}

/**
 * Destination をアーカイブ (soft delete, ADR-0012) する。
 * webhook_url を空文字にして暗号文ごと破棄し (復元不可)、従属 subscriptions を同時に削除する
 * (deleteDestinationById と同じ方式。src/api/rawQueries.ts 参照: subscriptions は destination を
 * 失うと無意味なため孤児レコードを残さない)。deliveries は配送履歴として意図的に残す。
 *
 * 冪等: 既にアーカイブ済み (archived_at が非NULL) の場合、UPDATE は 0 行になりエラーにはしない。
 * 呼び出し側は結果を無視し、常に最新の DestinationRow (getDestination 相当) を返してよい。
 */
export async function archiveDestination(db: D1Database, id: string): Promise<DestinationRow | null> {
  const now = nowIso();
  await db.batch([
    db.prepare(`DELETE FROM subscriptions WHERE destination_id = ?`).bind(id),
    db
      .prepare(
        `UPDATE destinations SET archived_at = ?, webhook_url = '', updated_at = ? WHERE id = ? AND archived_at IS NULL`
      )
      .bind(now, now, id),
  ]);
  return getDestination(db, id);
}

export async function createSubscription(
  db: D1Database,
  input: CreateSubscriptionInput
): Promise<SubscriptionRow> {
  const id = input.id ?? newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO subscriptions (id, destination_id, site_id, monitor_id, tag, change_kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.destinationId,
      input.siteId ?? null,
      input.monitorId ?? null,
      input.tag ?? null,
      input.changeKind ?? null,
      now,
      now
    )
    .run();
  return {
    id,
    destinationId: input.destinationId,
    siteId: input.siteId ?? null,
    monitorId: input.monitorId ?? null,
    tag: input.tag ?? null,
    changeKind: input.changeKind ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function listSubscriptionsByDestination(
  db: D1Database,
  destinationId: string
): Promise<SubscriptionRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM subscriptions WHERE destination_id = ? ORDER BY created_at ASC`)
    .bind(destinationId)
    .all();
  return results.map(mapSubscriptionRow);
}

/**
 * Change に一致する Subscription (site/monitor/kind でのフィルタ、いずれも NULL ならワイルドカード) を
 * 一致する Destination とともに返す。Subscription 配信ファンアウト (SPEC §14) の入力に使う。
 *
 * destinations を JOIN し archived_at IS NULL を条件に加える (ADR-0012)。アーカイブ時に従属
 * subscriptions は削除されるが、それとは独立にファンアウト側でも二重に防御する。
 */
export async function listMatchingSubscriptions(
  db: D1Database,
  match: { siteId: string; monitorId: string; kind: ChangeKind }
): Promise<SubscriptionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.* FROM subscriptions s
       JOIN destinations d ON d.id = s.destination_id
       WHERE (s.site_id IS NULL OR s.site_id = ?)
         AND (s.monitor_id IS NULL OR s.monitor_id = ?)
         AND (s.change_kind IS NULL OR s.change_kind = ?)
         AND d.archived_at IS NULL
       ORDER BY s.created_at ASC`
    )
    .bind(match.siteId, match.monitorId, match.kind)
    .all();
  return results.map(mapSubscriptionRow);
}
