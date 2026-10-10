/**
 * /api/executors — Executor の状態参照 (ADR-0023 §7)。
 * kind が home_runner のものには CrawlerObject の状態 (online、Runner ごとの情報、直近 1 時間の集計) を合わせる。
 */
import { Hono } from 'hono';
import { crawlerStub } from '../../do/crawlerObject';
import { getExecutor, listExecutors, parseExecutorCapabilities, type ExecutorRow } from '../../db';
import type { Env } from '../../shared/env';
import { notFound } from '../errors';

async function serialize(env: Env, row: ExecutorRow): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    id: row.id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    capabilities: parseExecutorCapabilities<unknown>(row, null),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
  if (row.kind !== 'home_runner') return base;

  const status = await crawlerStub(env, row.id).status();
  return {
    ...base,
    online: status.online,
    last_heartbeat_at: status.lastHeartbeatAt,
    runners: status.runners.map((r) => ({
      runner_id: r.runnerId,
      version: r.version,
      concurrency: r.concurrency,
      inflight: r.inflight,
      fetch_modes: r.fetchModes,
      last_seen_at: r.lastSeenAt,
      online: r.online,
    })),
    queued: status.queued,
    last_1h: status.last1h,
  };
}

export function executorsRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/', async (c) => {
    const rows = await listExecutors(c.env.DB);
    const items = await Promise.all(rows.map((row) => serialize(c.env, row)));
    return c.json({ items, total: items.length });
  });

  router.get('/:id', async (c) => {
    const row = await getExecutor(c.env.DB, c.req.param('id'));
    if (!row) throw notFound('executor_not_found', 'executor not found');
    return c.json(await serialize(c.env, row));
  });

  return router;
}
