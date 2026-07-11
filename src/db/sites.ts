import type { CreateSiteInput, SiteRow } from './types';
import { newId, nowIso } from './util';

function mapRow(row: Record<string, unknown>): SiteRow {
  return {
    id: row.id as string,
    name: row.name as string,
    primaryOrigin: (row.primary_origin as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function createSite(db: D1Database, input: CreateSiteInput): Promise<SiteRow> {
  const id = input.id ?? newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO sites (id, name, primary_origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
    .bind(id, input.name, input.primaryOrigin ?? null, now, now)
    .run();
  return { id, name: input.name, primaryOrigin: input.primaryOrigin ?? null, createdAt: now, updatedAt: now };
}

export async function getSite(db: D1Database, id: string): Promise<SiteRow | null> {
  const row = await db.prepare(`SELECT * FROM sites WHERE id = ?`).bind(id).first();
  return row ? mapRow(row) : null;
}

/**
 * Site名を変更する。対象が存在しない場合は null を返す (呼び出し側で404にする)。
 */
export async function updateSiteName(db: D1Database, id: string, name: string): Promise<SiteRow | null> {
  const result = await db
    .prepare(`UPDATE sites SET name = ?, updated_at = ? WHERE id = ?`)
    .bind(name, nowIso(), id)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return null;
  return getSite(db, id);
}

export async function listSites(
  db: D1Database,
  pagination?: { limit: number; offset: number }
): Promise<SiteRow[]> {
  const limitClause = pagination ? ` LIMIT ? OFFSET ?` : '';
  const stmt = db.prepare(`SELECT * FROM sites ORDER BY created_at ASC, id ASC${limitClause}`);
  const bound = pagination ? stmt.bind(pagination.limit, pagination.offset) : stmt.bind();
  const { results } = await bound.all();
  return results.map(mapRow);
}

/** sites の総数 (ページング用)。listSites と対で使う。 */
export async function countSites(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) as count FROM sites`).first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Site削除。呼び出し側 (API層) が countSourcesBySite で配下のSourceが無いことを
 * 事前に保証する (409ガード) ため、monitors/targets/changes等 (Source経由の子孫) は
 * ここで考慮不要 (Sourceが0件ならFK上それらも0件のはず)。
 *
 * site_id を直接参照するテーブルのうち削除が必要なもの:
 *  - fetcher_policies (UNIQUE site_id) とその entries
 *  - robots_policies (site_id, NOT NULL)
 *  - subscriptions (site_id, nullable)
 * robots_evaluations は origin単位の共有キャッシュであり site_id を持たないため対象外
 * (削除しない: 他Siteの同一originからも参照されうる)。
 */
export async function deleteSiteCascade(db: D1Database, siteId: string): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM fetcher_policy_entries WHERE fetcher_policy_id IN (SELECT id FROM fetcher_policies WHERE site_id = ?)`
      )
      .bind(siteId),
    db.prepare(`DELETE FROM fetcher_policies WHERE site_id = ?`).bind(siteId),
    db.prepare(`DELETE FROM robots_policies WHERE site_id = ?`).bind(siteId),
    db.prepare(`DELETE FROM subscriptions WHERE site_id = ?`).bind(siteId),
    db.prepare(`DELETE FROM sites WHERE id = ?`).bind(siteId),
  ]);
  const siteDeleteResult = results[results.length - 1];
  return (siteDeleteResult?.meta?.changes ?? 0) > 0;
}
