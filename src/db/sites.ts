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
