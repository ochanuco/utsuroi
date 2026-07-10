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

export async function listSites(db: D1Database): Promise<SiteRow[]> {
  const { results } = await db.prepare(`SELECT * FROM sites ORDER BY created_at ASC`).all();
  return results.map(mapRow);
}
