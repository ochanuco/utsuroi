/**
 * /api/changes (SPEC §12, §17.10 差分確認)
 */
import { Hono } from 'hono';
import type { Env } from '../../shared/env';
import { getChange, listChangesByMonitor } from '../../db';
import { badRequest, notFound } from '../errors';
import { paginate, parsePagination } from '../http';
import { serializeChange } from '../serialize';

export function changesRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/', async (c) => {
    const monitorId = c.req.query('monitor_id');
    if (!monitorId) throw badRequest('monitor_id_required', 'monitor_id query parameter is required');

    const pagination = parsePagination(c);
    const changes = await listChangesByMonitor(c.env.DB, monitorId);
    return c.json({ items: paginate(changes, pagination).map(serializeChange), total: changes.length });
  });

  router.get('/:id', async (c) => {
    const change = await getChange(c.env.DB, c.req.param('id'));
    if (!change) throw notFound('change_not_found', 'change not found');
    return c.json(serializeChange(change));
  });

  router.get('/:id/diff', async (c) => {
    const change = await getChange(c.env.DB, c.req.param('id'));
    if (!change) throw notFound('change_not_found', 'change not found');
    if (!change.diffR2Key) throw notFound('diff_not_available', 'no diff body stored for this change');

    const object = await c.env.BODIES.get(change.diffR2Key);
    if (!object) throw notFound('diff_not_available', 'diff body not found in storage');

    const text = await object.text();
    return c.text(text, 200, { 'content-type': 'text/plain; charset=utf-8' });
  });

  return router;
}
