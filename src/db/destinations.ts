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
  return { id, name: input.name, webhookUrl: input.webhookUrl, enabled, createdAt: now, updatedAt: now };
}

export async function getDestination(db: D1Database, id: string): Promise<DestinationRow | null> {
  const row = await db.prepare(`SELECT * FROM destinations WHERE id = ?`).bind(id).first();
  return row ? mapDestinationRow(row) : null;
}

export async function listDestinations(db: D1Database): Promise<DestinationRow[]> {
  const { results } = await db.prepare(`SELECT * FROM destinations ORDER BY created_at ASC`).all();
  return results.map(mapDestinationRow);
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
 */
export async function listMatchingSubscriptions(
  db: D1Database,
  match: { siteId: string; monitorId: string; kind: ChangeKind }
): Promise<SubscriptionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM subscriptions
       WHERE (site_id IS NULL OR site_id = ?)
         AND (monitor_id IS NULL OR monitor_id = ?)
         AND (change_kind IS NULL OR change_kind = ?)
       ORDER BY created_at ASC`
    )
    .bind(match.siteId, match.monitorId, match.kind)
    .all();
  return results.map(mapSubscriptionRow);
}
