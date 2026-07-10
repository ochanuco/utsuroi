/**
 * /api/fetchers — 利用可能な Fetcher の参照 (読み取り専用)。
 * Fetcher はシード (migrations/0004) で管理するマスタデータで、
 * UI の Fetcher Policy エディタが選択肢として使う。
 */
import { Hono } from 'hono';
import type { Env } from '../../shared/env';
import { listFetchers } from '../../db';

export function fetchersRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/', async (c) => {
    const fetchers = await listFetchers(c.env.DB);
    return c.json({
      items: fetchers.map((f) => ({
        id: f.id,
        executor_id: f.executorId,
        fetch_mode: f.fetchMode,
        region: f.region,
      })),
      total: fetchers.length,
    });
  });

  return router;
}
