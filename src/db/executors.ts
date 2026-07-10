import type { CreateExecutorInput, ExecutorRow } from './types';
import { newId, nowIso, parseJson, toJson } from './util';

function mapRow(row: Record<string, unknown>): ExecutorRow {
  return {
    id: row.id as string,
    kind: row.kind as string,
    name: row.name as string,
    capabilities: (row.capabilities as string | null) ?? null,
    status: row.status as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function createExecutor(db: D1Database, input: CreateExecutorInput): Promise<ExecutorRow> {
  const id = input.id ?? newId();
  const now = nowIso();
  const status = input.status ?? 'active';
  const capabilities = toJson(input.capabilities);
  await db
    .prepare(
      `INSERT INTO executors (id, kind, name, capabilities, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, input.kind, input.name, capabilities, status, now, now)
    .run();
  return { id, kind: input.kind, name: input.name, capabilities, status, createdAt: now, updatedAt: now };
}

export async function getExecutor(db: D1Database, id: string): Promise<ExecutorRow | null> {
  const row = await db.prepare(`SELECT * FROM executors WHERE id = ?`).bind(id).first();
  return row ? mapRow(row) : null;
}

export async function listExecutors(db: D1Database): Promise<ExecutorRow[]> {
  const { results } = await db.prepare(`SELECT * FROM executors ORDER BY created_at ASC`).all();
  return results.map(mapRow);
}

/** capabilities 列の JSON を任意の型でパースするヘルパー (wave2 が自由な shape で利用できるよう公開) */
export function parseExecutorCapabilities<T>(executor: ExecutorRow, fallback: T): T {
  return parseJson(executor.capabilities, fallback);
}
