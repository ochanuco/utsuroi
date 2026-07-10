/**
 * D1 バックの RobotsCache 実装 (migrations/0002_wave2.sql の robots_cache テーブル)。
 * checkRobots (src/robots/check.ts) の TTL 判定はキャッシュ利用側が行うため、ここでは
 * 単純な get/put のみを担う。
 */
import type { CachedRobots, RobotsCache, RobotsRules } from '../robots';

interface RobotsCacheRow {
  origin: string;
  robots_url: string;
  fetched_at: string;
  unavailable: number;
  rules: string | null;
}

function toCachedRobots(row: RobotsCacheRow): CachedRobots {
  const rules: RobotsRules = row.rules
    ? (JSON.parse(row.rules) as RobotsRules)
    : { groups: [], sitemaps: [] };
  return {
    robotsUrl: row.robots_url,
    fetchedAt: row.fetched_at,
    rules,
    unavailable: row.unavailable === 1,
  };
}

export function createD1RobotsCache(db: D1Database): RobotsCache {
  return {
    async get(origin: string): Promise<CachedRobots | null> {
      const row = await db
        .prepare(`SELECT * FROM robots_cache WHERE origin = ?`)
        .bind(origin)
        .first<RobotsCacheRow>();
      return row ? toCachedRobots(row) : null;
    },
    async put(origin: string, value: CachedRobots): Promise<void> {
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO robots_cache (origin, robots_url, fetched_at, unavailable, rules, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(origin) DO UPDATE SET
             robots_url = excluded.robots_url,
             fetched_at = excluded.fetched_at,
             unavailable = excluded.unavailable,
             rules = excluded.rules,
             updated_at = excluded.updated_at`,
        )
        .bind(
          origin,
          value.robotsUrl,
          value.fetchedAt,
          value.unavailable ? 1 : 0,
          value.unavailable ? null : JSON.stringify(value.rules),
          now,
          now,
        )
        .run();
    },
  };
}
