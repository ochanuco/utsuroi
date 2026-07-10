/**
 * /api/audit-events (ADR-0009 監査ログ参照)
 */
import { Hono } from 'hono';
import type { Env } from '../../shared/env';
import { countAuditEvents, listRecentAuditEvents } from '../../db';
import { paginate, parsePagination } from '../http';
import { serializeAuditEvent } from '../serialize';

export function auditEventsRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/', async (c) => {
    const pagination = parsePagination(c);
    // listRecentAuditEvents は limit のみ受け取るため、offset 分を多めに取得してから切り出す。
    const events = await listRecentAuditEvents(c.env.DB, pagination.offset + pagination.limit);
    const total = await countAuditEvents(c.env.DB);
    return c.json({ items: paginate(events, pagination).map(serializeAuditEvent), total });
  });

  return router;
}
