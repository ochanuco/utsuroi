import type { CreateFetcherInput, FetcherRow } from './types';
import { nowIso, toJson } from './util';

function mapRow(row: Record<string, unknown>): FetcherRow {
  return {
    id: row.id as string,
    executorId: row.executor_id as string,
    fetchMode: row.fetch_mode as FetcherRow['fetchMode'],
    region: (row.region as string | null) ?? null,
    profile: (row.profile as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function createFetcher(db: D1Database, input: CreateFetcherInput): Promise<FetcherRow> {
  const now = nowIso();
  const profile = toJson(input.profile);
  await db
    .prepare(
      `INSERT INTO fetchers (id, executor_id, fetch_mode, region, profile, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(input.id, input.executorId, input.fetchMode, input.region ?? null, profile, now, now)
    .run();
  return {
    id: input.id,
    executorId: input.executorId,
    fetchMode: input.fetchMode,
    region: input.region ?? null,
    profile,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getFetcher(db: D1Database, id: string): Promise<FetcherRow | null> {
  const row = await db.prepare(`SELECT * FROM fetchers WHERE id = ?`).bind(id).first();
  return row ? mapRow(row) : null;
}

export async function listFetchers(db: D1Database): Promise<FetcherRow[]> {
  const { results } = await db.prepare(`SELECT * FROM fetchers ORDER BY created_at ASC`).all();
  return results.map(mapRow);
}
