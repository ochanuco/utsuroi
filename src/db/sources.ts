import type { CreateSourceInput, SourceConfig, SourceRow } from './types';
import { newId, nowIso, parseJson, toJson } from './util';

function mapRow(row: Record<string, unknown>): SourceRow {
  return {
    id: row.id as string,
    siteId: row.site_id as string,
    type: row.type as SourceRow['type'],
    url: row.url as string,
    // config 列は JSON文字列 (未設定は NULL)。parse失敗時も null 扱いにする (parseJson の既定挙動)。
    config: parseJson<SourceConfig | null>(row.config as string | null, null),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function createSource(db: D1Database, input: CreateSourceInput): Promise<SourceRow> {
  const id = input.id ?? newId();
  const now = nowIso();
  const config = input.config ?? null;
  await db
    .prepare(
      `INSERT INTO sources (id, site_id, type, url, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, input.siteId, input.type, input.url, toJson(config), now, now)
    .run();
  return { id, siteId: input.siteId, type: input.type, url: input.url, config, createdAt: now, updatedAt: now };
}

export async function getSource(db: D1Database, id: string): Promise<SourceRow | null> {
  const row = await db.prepare(`SELECT * FROM sources WHERE id = ?`).bind(id).first();
  return row ? mapRow(row) : null;
}

export async function listSourcesBySite(
  db: D1Database,
  siteId: string,
  pagination?: { limit: number; offset: number }
): Promise<SourceRow[]> {
  const limitClause = pagination ? ` LIMIT ? OFFSET ?` : '';
  const stmt = db.prepare(`SELECT * FROM sources WHERE site_id = ? ORDER BY created_at ASC${limitClause}`);
  const bound = pagination ? stmt.bind(siteId, pagination.limit, pagination.offset) : stmt.bind(siteId);
  const { results } = await bound.all();
  return results.map(mapRow);
}

/**
 * Source の config だけを丸ごと置き換える (ADR-0013、PATCH /api/sources/:id)。
 * url/type/site_id はここでは変更しない。対象が存在しない場合は null を返す (呼び出し側で404にする)。
 */
export async function updateSourceConfig(
  db: D1Database,
  id: string,
  config: SourceConfig | null
): Promise<SourceRow | null> {
  const result = await db
    .prepare(`UPDATE sources SET config = ?, updated_at = ? WHERE id = ?`)
    .bind(toJson(config), nowIso(), id)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return null;
  return getSource(db, id);
}

export async function countSourcesBySite(db: D1Database, siteId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as count FROM sources WHERE site_id = ?`)
    .bind(siteId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Source削除。呼び出し側 (API層) が countMonitorsBySource で配下のMonitorが無いことを
 * 事前に保証する (409ガード) ため、ここでは単純な単一行DELETEでよい。
 */
export async function deleteSource(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM sources WHERE id = ?`).bind(id).run();
  return (result.meta?.changes ?? 0) > 0;
}
