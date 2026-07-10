import type { AuditEventRow, CreateAuditEventInput } from './types';
import { newId, nowIso, parseJson, toJson } from './util';

function mapRow(row: Record<string, unknown>): AuditEventRow {
  return {
    id: row.id as string,
    actor: row.actor as string,
    action: row.action as string,
    subject: row.subject as string,
    reason: (row.reason as string | null) ?? null,
    payload: parseJson(row.payload as string | null, null),
    createdAt: row.created_at as string,
  };
}

/** 監査ログへの追記のみ (append-only、更新・削除は提供しない) */
export async function recordAuditEvent(
  db: D1Database,
  input: CreateAuditEventInput
): Promise<AuditEventRow> {
  const id = input.id ?? newId();
  const now = nowIso();
  const payload = toJson(input.payload);
  await db
    .prepare(
      `INSERT INTO audit_events (id, actor, action, subject, reason, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, input.actor, input.action, input.subject, input.reason ?? null, payload, now)
    .run();
  return {
    id,
    actor: input.actor,
    action: input.action,
    subject: input.subject,
    reason: input.reason ?? null,
    payload: input.payload ?? null,
    createdAt: now,
  };
}

export async function listAuditEventsBySubject(
  db: D1Database,
  subject: string,
  limit = 200
): Promise<AuditEventRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM audit_events WHERE subject = ? ORDER BY created_at ASC LIMIT ?`)
    .bind(subject, limit)
    .all();
  return results.map(mapRow);
}

export async function listRecentAuditEvents(db: D1Database, limit = 100): Promise<AuditEventRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?`)
    .bind(limit)
    .all();
  return results.map(mapRow);
}

export async function countAuditEvents(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) as count FROM audit_events`).first<{ count: number }>();
  return row?.count ?? 0;
}
