/**
 * /api/destinations (SPEC §14, Webhook URL は平文表示しない / §15 暗号化保存)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../shared/env';
import { createDestination, encryptWebhookUrl, getDestination, listDestinations } from '../../db';
import { checkUrlForSsrf } from '../../net';
import { badRequest, notFound, serviceUnavailable } from '../errors';
import { maskWebhookUrl } from '../mask';
import { paginate, parsePagination, parseWith, readJsonBody } from '../http';
import { deleteDestinationById } from '../rawQueries';
import { serializeDestination } from '../serialize';

const createDestinationSchema = z.object({
  name: z.string().min(1),
  webhook_url: z.string().min(1),
});

/** 絶対 http(s) URL であること、および SSRF ポリシー (private/metadata/userinfo/不正ポート) を検査する */
function assertValidWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest('invalid_webhook_url', 'webhook_url must be a valid absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('invalid_webhook_url', 'webhook_url must be a valid absolute http(s) URL');
  }
  const ssrf = checkUrlForSsrf(url);
  if (!ssrf.allowed) {
    throw badRequest('invalid_webhook_url', `webhook_url rejected by url safety policy: ${ssrf.reason ?? 'unknown'}`);
  }
}

export function destinationsRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.post('/', async (c) => {
    const body = parseWith(createDestinationSchema, await readJsonBody(c));
    assertValidWebhookUrl(body.webhook_url);

    const encKey = c.env.WEBHOOK_ENC_KEY;
    if (!encKey) {
      // 平文フォールバックはしない: 鍵未設定時は作成自体を拒否する (SPEC §15)。
      throw serviceUnavailable(
        'webhook_encryption_unavailable',
        'WEBHOOK_ENC_KEY is not configured; cannot store an encrypted webhook_url',
      );
    }
    const masked = maskWebhookUrl(body.webhook_url);
    const encryptedWebhookUrl = await encryptWebhookUrl(body.webhook_url, masked, encKey);

    const destination = await createDestination(c.env.DB, { name: body.name, webhookUrl: encryptedWebhookUrl });
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
