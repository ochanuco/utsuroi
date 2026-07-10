import type { RobotsVerdict } from '../shared/contracts';
import type {
  CreateRobotsEvaluationInput,
  RobotsEvaluationRow,
  RobotsPolicyRow,
  UpsertRobotsPolicyInput,
} from './types';
import { fromBool, newId, nowIso, toBool } from './util';

function mapPolicyRow(row: Record<string, unknown>): RobotsPolicyRow {
  return {
    id: row.id as string,
    siteId: row.site_id as string,
    canonicalOrigin: row.canonical_origin as string,
    mode: row.mode as RobotsPolicyRow['mode'],
    reason: (row.reason as string | null) ?? null,
    updatedBy: (row.updated_by as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapEvaluationRow(row: Record<string, unknown>): RobotsEvaluationRow {
  return {
    id: row.id as string,
    origin: row.origin as string,
    verdict: row.verdict as RobotsVerdict,
    robotsUrl: row.robots_url as string,
    checkedAt: row.checked_at as string,
    userAgentGroup: row.user_agent_group as string,
    matchedRule: (row.matched_rule as string | null) ?? null,
    unavailable: toBool(row.unavailable as number),
    robotsWouldBlock: toBool(row.robots_would_block as number),
    robotsHash: (row.robots_hash as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

/**
 * site_id + canonical_origin 単位の robots.txt Policy (enforce/ignore, ADR-0009) を upsert する。
 * 行が存在しなければ既定 (`enforce`) 相当として扱われるので、ここには override が
 * 明示設定されたときのみ書き込む想定。
 */
export async function upsertRobotsPolicy(
  db: D1Database,
  input: UpsertRobotsPolicyInput
): Promise<RobotsPolicyRow> {
  const now = nowIso();
  const existing = await db
    .prepare(`SELECT id, created_at FROM robots_policies WHERE site_id = ? AND canonical_origin = ?`)
    .bind(input.siteId, input.canonicalOrigin)
    .first<{ id: string; created_at: string }>();
  const id = existing?.id ?? newId();
  const createdAt = existing?.created_at ?? now;

  await db
    .prepare(
      `INSERT INTO robots_policies (id, site_id, canonical_origin, mode, reason, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id, canonical_origin) DO UPDATE SET
         mode = excluded.mode,
         reason = excluded.reason,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`
    )
    .bind(
      id,
      input.siteId,
      input.canonicalOrigin,
      input.mode,
      input.reason ?? null,
      input.updatedBy ?? null,
      createdAt,
      now
    )
    .run();

  // upsert 後に再取得して永続化済みの行を返す (INSERT/UPDATE いずれの経路でも
  // DB の実データと戻り値を一致させるため。以前は競合(UPDATE)時にも id/createdAt を
  // 生成前の値のまま返しており、実際に保存された値と食い違うバグがあった)。
  const persisted = await db
    .prepare(`SELECT * FROM robots_policies WHERE site_id = ? AND canonical_origin = ?`)
    .bind(input.siteId, input.canonicalOrigin)
    .first();
  if (!persisted) throw new Error('upsertRobotsPolicy: row not found after upsert');
  return mapPolicyRow(persisted);
}

export async function getRobotsPolicy(
  db: D1Database,
  siteId: string,
  canonicalOrigin: string
): Promise<RobotsPolicyRow | null> {
  const row = await db
    .prepare(`SELECT * FROM robots_policies WHERE site_id = ? AND canonical_origin = ?`)
    .bind(siteId, canonicalOrigin)
    .first();
  return row ? mapPolicyRow(row) : null;
}

/** 明示 Override が無い場合の既定モード (ADR-0008: 既定は enforce) */
export async function getRobotsMode(
  db: D1Database,
  siteId: string,
  canonicalOrigin: string
): Promise<'enforce' | 'ignore'> {
  const policy = await getRobotsPolicy(db, siteId, canonicalOrigin);
  return policy?.mode ?? 'enforce';
}

export async function createRobotsEvaluation(
  db: D1Database,
  input: CreateRobotsEvaluationInput
): Promise<RobotsEvaluationRow> {
  const id = input.id ?? newId();
  const now = nowIso();
  const checkedAt = input.checkedAt ?? now;
  const unavailable = input.unavailable ?? false;
  const robotsWouldBlock = input.robotsWouldBlock ?? false;
  await db
    .prepare(
      `INSERT INTO robots_evaluations
        (id, origin, verdict, robots_url, checked_at, user_agent_group, matched_rule, unavailable, robots_would_block, robots_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.origin,
      input.verdict,
      input.robotsUrl,
      checkedAt,
      input.userAgentGroup,
      input.matchedRule ?? null,
      fromBool(unavailable),
      fromBool(robotsWouldBlock),
      input.robotsHash ?? null,
      now
    )
    .run();
  return {
    id,
    origin: input.origin,
    verdict: input.verdict,
    robotsUrl: input.robotsUrl,
    checkedAt,
    userAgentGroup: input.userAgentGroup,
    matchedRule: input.matchedRule ?? null,
    unavailable,
    robotsWouldBlock,
    robotsHash: input.robotsHash ?? null,
    createdAt: now,
  };
}

export async function getRobotsEvaluation(db: D1Database, id: string): Promise<RobotsEvaluationRow | null> {
  const row = await db.prepare(`SELECT * FROM robots_evaluations WHERE id = ?`).bind(id).first();
  return row ? mapEvaluationRow(row) : null;
}

/** origin 単位の直近評価結果 (キャッシュ判定・再評価規則に使う) */
export async function getLatestRobotsEvaluation(
  db: D1Database,
  origin: string
): Promise<RobotsEvaluationRow | null> {
  const row = await db
    .prepare(`SELECT * FROM robots_evaluations WHERE origin = ? ORDER BY checked_at DESC LIMIT 1`)
    .bind(origin)
    .first();
  return row ? mapEvaluationRow(row) : null;
}
