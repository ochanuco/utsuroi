/**
 * /api/destinations (SPEC §14, Webhook URL は平文表示しない)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../shared/env';
import { createDestination, getDestination, listDestinations } from '../../db';
import { badRequest, notFound } from '../errors';
import { paginate, parsePagination, parseWith, readJsonBody } from '../http';
import { deleteDestinationById } from '../rawQueries';
import { serializeDestination } from '../serialize';

const createDestinationSchema = z.object({
  name: z.string().min(1),
  webhook_url: z.string().min(1),
});

function assertValidWebhookUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported scheme');
    }
  } catch {
    throw badRequest('invalid_webhook_url', 'webhook_url must be a valid absolute http(s) URL');
  }
}

export function destinationsRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.post('/', async (c) => {
    const body = parseWith(createDestinationSchema, await readJsonBody(c));
    assertValidWebhookUrl(body.webhook_url);

    const destination = await createDestination(c.env.DB, { name: body.name, webhookUrl: body.webhook_url });
    return c.json(serializeDestination(destination), 201);
  });

  router.get('/', async (c) => {
    const pagination = parsePagination(c);
    const destinations = await listDestinations(c.env.DB);
    return c.json({
      items: paginate(destinations, pagination).map(serializeDestination),
      total: destinations.length,
    });
  });

  router.get('/:id', async (c) => {
    const destination = await getDestination(c.env.DB, c.req.param('id'));
    if (!destination) throw notFound('destination_not_found', 'destination not found');
    return c.json(serializeDestination(destination));
  });

  router.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const destination = await getDestination(c.env.DB, id);
    if (!destination) throw notFound('destination_not_found', 'destination not found');

    await deleteDestinationById(c.env.DB, id);
    return c.json({ deleted: true });
  });

  return router;
}
