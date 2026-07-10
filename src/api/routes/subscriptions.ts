/**
 * /api/subscriptions (SPEC §14)
 *
 * DB モデル (SubscriptionRow) は changeKind を単一値でしか保持しないため、
 * 複数 kind を購読したい場合は kind ごとに複数 Subscription を作る運用を想定する。
 * リクエストでは利便性のため `kind` (単一) と `kinds` (配列、先頭要素のみ採用) の
 * 両方を受け付ける。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../shared/env';
import { createSubscription, getDestination, getMonitor, getSite, listSubscriptionsByDestination } from '../../db';
import { badRequest, notFound } from '../errors';
import { paginate, parsePagination, parseWith, readJsonBody } from '../http';
import { deleteSubscriptionById, getSubscriptionById } from '../rawQueries';
import { serializeSubscription } from '../serialize';

const changeKindSchema = z.enum(['new', 'updated', 'removed']);

const createSubscriptionSchema = z.object({
  destination_id: z.string().min(1),
  site_id: z.string().min(1).nullable().optional(),
  monitor_id: z.string().min(1).nullable().optional(),
  tag: z.string().nullable().optional(),
  kind: changeKindSchema.nullable().optional(),
  kinds: z.array(changeKindSchema).optional(),
});

export function subscriptionsRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.post('/', async (c) => {
    const body = parseWith(createSubscriptionSchema, await readJsonBody(c));

    const destination = await getDestination(c.env.DB, body.destination_id);
    if (!destination) throw notFound('destination_not_found', 'destination not found');

    if (body.site_id) {
      const site = await getSite(c.env.DB, body.site_id);
      if (!site) throw notFound('site_not_found', 'site not found');
    }
    if (body.monitor_id) {
      const monitor = await getMonitor(c.env.DB, body.monitor_id);
      if (!monitor) throw notFound('monitor_not_found', 'monitor not found');
    }

    const changeKind = body.kind ?? body.kinds?.[0] ?? null;
    const subscription = await createSubscription(c.env.DB, {
      destinationId: body.destination_id,
      siteId: body.site_id ?? null,
      monitorId: body.monitor_id ?? null,
      tag: body.tag ?? null,
      changeKind,
    });
    return c.json(serializeSubscription(subscription), 201);
  });

  router.get('/', async (c) => {
    const destinationId = c.req.query('destination_id');
    if (!destinationId) throw badRequest('destination_id_required', 'destination_id query parameter is required');

    const pagination = parsePagination(c);
    const subscriptions = await listSubscriptionsByDestination(c.env.DB, destinationId);
    return c.json({
      items: paginate(subscriptions, pagination).map(serializeSubscription),
      total: subscriptions.length,
    });
  });

  router.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const existing = await getSubscriptionById(c.env.DB, id);
    if (!existing) throw notFound('subscription_not_found', 'subscription not found');

    await deleteSubscriptionById(c.env.DB, id);
    return c.json({ deleted: true });
  });

  return router;
}
