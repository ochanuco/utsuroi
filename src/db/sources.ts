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

export async function listSourcesBySite(db: D1Database, siteId: string): Promise<SourceRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM sources WHERE site_id = ? ORDER BY created_at ASC`)
    .bind(siteId)
    .all();
  return results.map(mapRow);
}
