/**
 * src/db (wave1) が公開していない操作のための最小限の直接クエリ。
 *
 * スコープ上 src/db/** は編集禁止のため、以下の操作は db 層に追加できない:
 *  - destinations / subscriptions の削除 (db 層に delete 系関数が無い)
 *  - site 単位の robots_policies 一覧取得 (db 層は site_id+origin 単位の get のみ)
 *
 * ここでは env.DB (D1Database binding) を直接使い、上記の欠落を API 層で最小限補う。
 * 将来 wave1 側に相当する関数が追加されたら、ここは削除して db 層へ委譲するべき。
 */
import type { RobotsMode } from '../shared/types';
import type { RobotsPolicyRow } from '../db';

export async function deleteDestinationById(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM destinations WHERE id = ?`).bind(id).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function deleteSubscriptionById(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM subscriptions WHERE id = ?`).bind(id).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function getSubscriptionById(
  db: D1Database,
  id: string
): Promise<Record<string, unknown> | null> {
  const row = await db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).bind(id).first();
  return row ?? null;
}

function mapRobotsPolicyRow(row: Record<string, unknown>): RobotsPolicyRow {
  return {
    id: row.id as string,
    siteId: row.site_id as string,
    canonicalOrigin: row.canonical_origin as string,
    mode: row.mode as RobotsMode,
    reason: (row.reason as string | null) ?? null,
    updatedBy: (row.updated_by as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** site 単位の robots_policies 一覧 (現在有効な override 一覧表示用) */
export async function listRobotsPoliciesBySite(db: D1Database, siteId: string): Promise<RobotsPolicyRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM robots_policies WHERE site_id = ? ORDER BY updated_at DESC`)
    .bind(siteId)
    .all();
  return results.map(mapRobotsPolicyRow);
}
