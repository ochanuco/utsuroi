import type { CreateSourceInput, SourceRow } from './types';
import { newId, nowIso } from './util';

function mapRow(row: Record<string, unknown>): SourceRow {
  return {
    id: row.id as string,
    siteId: row.site_id as string,
    type: row.type as SourceRow['type'],
    url: row.url as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function createSource(db: D1Database, input: CreateSourceInput): Promise<SourceRow> {
  const id = input.id ?? newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO sources (id, site_id, type, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, input.siteId, input.type, input.url, now, now)
    .run();
  return { id, siteId: input.siteId, type: input.type, url: input.url, createdAt: now, updatedAt: now };
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

export async function countSourcesBySite(db: D1Database, siteId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as count FROM sources WHERE site_id = ?`)
    .bind(siteId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
