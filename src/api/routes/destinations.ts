/**
 * /api/destinations (SPEC §14, Webhook URL は平文表示しない / §15 暗号化保存)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../shared/env';
import {
  archiveDestination,
  createDestination,
  encryptWebhookUrl,
  getDestination,
  listDestinations,
  recordAuditEvent,
  updateDestinationThreadId,
} from '../../db';
import { checkUrlForSsrf } from '../../net';
import { isDiscordWebhookHost } from '../../notify/discord';
import { badRequest, conflict, notFound, serviceUnavailable } from '../errors';
import { maskWebhookUrl } from '../mask';
import { paginate, parsePagination, parseWith, readJsonBody } from '../http';
import { deleteDestinationById, isForeignKeyConstraintError } from '../rawQueries';
import { serializeDestination } from '../serialize';

/** Discord のスレッド ID (snowflake)。17〜20桁の数字文字列 (ADR-0019) */
const THREAD_ID_PATTERN = /^\d{17,20}$/;

const createDestinationSchema = z.object({
  name: z.string().min(1),
  webhook_url: z.string().min(1),
  thread_id: z.string().regex(THREAD_ID_PATTERN, 'thread_id must be a 17-20 digit snowflake').nullable().optional(),
});

// ADR-0019: PATCH /api/destinations/:id は thread_id のみを更新する単一フィールドPATCH
// (source.update_config と同じ形)。url/webhook_url/name/enabled はここでは変更しない。
const updateDestinationSchema = z.object({
  thread_id: z.string().regex(THREAD_ID_PATTERN, 'thread_id must be a 17-20 digit snowflake').nullable(),
}).strict();

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
  // Discord の既知ドメインへ限定する (DNS rebinding への回答。src/notify/discord.ts の
  // isDiscordWebhookHost 側のコメント参照)。登録時 (ここ) と送信直前 (sendToDiscord) の
  // 両方に同じ allowlist を適用し、単一の実装 (isDiscordWebhookHost) を共有する。
  if (!isDiscordWebhookHost(parsed.hostname)) {
    throw badRequest(
      'invalid_webhook_url',
      'webhook_url must be a Discord webhook endpoint (discord.com / discordapp.com)',
    );
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

    const destination = await createDestination(c.env.DB, {
      name: body.name,
      webhookUrl: encryptedWebhookUrl,
      threadId: body.thread_id ?? null,
    });
    return c.json(serializeDestination(destination), 201);
  });

  // ADR-0019: Discord スレッドへの投稿先を後から設定/変更する。archived な Destination への
  // 更新は subscriptions.ts の createSubscription と同じ 400 destination_archived にする
  // (archive 済みは webhook_url が破棄済みで実質配送不能なため、設定変更自体を許可しない)。
  router.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const destination = await getDestination(c.env.DB, id);
    if (!destination) throw notFound('destination_not_found', 'destination not found');
    if (destination.archivedAt !== null) {
      throw badRequest('destination_archived', 'cannot update an archived destination');
    }

    const body = parseWith(updateDestinationSchema, await readJsonBody(c));
    const updated = await updateDestinationThreadId(c.env.DB, id, body.thread_id);
    if (!updated) throw notFound('destination_not_found', 'destination not found');

    await recordAuditEvent(c.env.DB, {
      actor: 'admin',
      action: 'destination.update',
      subject: id,
      payload: { before: { threadId: destination.threadId }, after: { threadId: updated.threadId } },
    });

    return c.json(serializeDestination(updated));
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

    // deleteDestinationById は従属 subscriptions を同時に削除するが、deliveries は配送履歴
    // として意図的に残す (src/api/rawQueries.ts 参照)。delivery 履歴が残っている destination は
    // FOREIGN KEY 制約違反として削除が拒否されるため、ここで 409 Conflict に変換する。
    try {
      await deleteDestinationById(c.env.DB, id);
    } catch (err) {
      if (isForeignKeyConstraintError(err)) {
        throw conflict(
          'destination_has_delivery_history',
          'cannot delete a destination that still has delivery history; ' +
            `archive it instead (POST /api/destinations/${id}/archive)`,
        );
      }
      throw err;
    }
    return c.json({ deleted: true });
  });

  // ADR-0012: 配送履歴を保ったまま Destination を片付ける soft delete。webhook_url を破棄し
  // (復元不可)、従属 subscriptions を削除する。冪等: アーカイブ済みへの再実行も 200 を返す。
  router.post('/:id/archive', async (c) => {
    const id = c.req.param('id');
    const destination = await getDestination(c.env.DB, id);
    if (!destination) throw notFound('destination_not_found', 'destination not found');

    const wasAlreadyArchived = destination.archivedAt !== null;
    const archived = await archiveDestination(c.env.DB, id);
    if (!archived) throw notFound('destination_not_found', 'destination not found');

    if (!wasAlreadyArchived) {
      await recordAuditEvent(c.env.DB, {
        actor: 'admin',
        action: 'destination.archive',
        subject: id,
        payload: { destinationId: id },
      });
    }

    return c.json(serializeDestination(archived));
  });

  return router;
}
