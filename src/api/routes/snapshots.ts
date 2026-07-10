/**
 * /api/snapshots (SPEC §17 受け入れ条件10 変更前後の本文表示)
 */
import { Hono } from 'hono';
import type { Env } from '../../shared/env';
import { getSnapshot } from '../../db';
import { notFound } from '../errors';
import { serializeSnapshot } from '../serialize';

export function snapshotsRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/:id', async (c) => {
    const snapshot = await getSnapshot(c.env.DB, c.req.param('id'));
    if (!snapshot) throw notFound('snapshot_not_found', 'snapshot not found');
    return c.json(serializeSnapshot(snapshot));
  });

  router.get('/:id/body', async (c) => {
    const snapshot = await getSnapshot(c.env.DB, c.req.param('id'));
    if (!snapshot) throw notFound('snapshot_not_found', 'snapshot not found');
    if (!snapshot.r2Key) throw notFound('body_not_available', 'no body stored for this snapshot');

    const object = await c.env.BODIES.get(snapshot.r2Key);
    if (!object) throw notFound('body_not_available', 'snapshot body not found in storage');

    // 保存された本文は監視対象サイトが返した生 HTML/テキストであり、信頼できない。
    // Content-Type を保存時の contentType (例: text/html) のまま返すと、この API オリジン上で
    // stored XSS を引き起こしうる (ブラウザがレスポンスを HTML として描画してしまう)。
    // そのため常に text/plain 固定 + X-Content-Type-Options: nosniff で返し、
    // クライアント (Web UI) 側で意図的にテキストとして扱わせる。
    // R2Object.body (ReadableStream) をそのまま Response に渡し、本文全体をメモリに
    // バッファしないようにする (大きな本文でのメモリ効率のため)。
    return new Response(object.body, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  return router;
}
