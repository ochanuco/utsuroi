/**
 * Notify Queue コンシューマ本体。
 * D1 への依存は NotifyStore インターフェース経由のみ (契約: src/shared/contracts.ts)。
 */
import type { NotifyQueueMessage, NotifyStore } from '../shared/contracts';
import { buildDiscordPayload, maskWebhookUrl, sendToDiscord } from './discord';

/** 実 Cloudflare Queues の MessageBatch と互換な最小 interface (vitest から直接呼べるようにする) */
export interface NotifyBatchMessage {
  body: NotifyQueueMessage;
  ack(): void;
  retry(opts?: { delaySeconds?: number }): void;
}

/** 実 Cloudflare Queues の MessageBatch と互換な最小 interface */
export interface NotifyMessageBatch {
  messages: NotifyBatchMessage[];
}

export interface ProcessNotifyBatchOptions {
  /** テスト用の fetch 差し替え。省略時はグローバル fetch */
  fetch?: typeof fetch;
  /** これ以上の attemptCount は dead 扱いにする。既定 5 */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;

/** 429 以外の 4xx は permanent 失敗 (webhook 削除等、リトライしても回復しない) */
function isPermanentFailure(status: number | null): boolean {
  if (status === null) return false; // ネットワークエラーはリトライ可能
  if (status === 429) return false; // 429 は専用ハンドリング
  return status >= 400 && status < 500;
}

async function processOne(
  message: NotifyBatchMessage,
  store: NotifyStore,
  opts: ProcessNotifyBatchOptions,
): Promise<void> {
  const { deliveryId } = message.body;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const pending = await store.getPendingDelivery(deliveryId);
  if (pending === null) {
    // 配送済み、または不明な delivery id。冪等スキップ。
    message.ack();
    return;
  }

  if (pending.attemptCount >= maxAttempts) {
    await store.markFailed(deliveryId, `max attempts (${maxAttempts}) exceeded`, { dead: true });
    message.ack();
    return;
  }

  const payload = buildDiscordPayload(pending.change);
  const result = await sendToDiscord(pending.webhookUrl, payload, { fetch: opts.fetch });

  if (result.ok) {
    await store.markDelivered(deliveryId);
    message.ack();
    return;
  }

  if (result.status === 429) {
    // Retry-After を尊重しつつ (SPEC §14)、attemptCount もインクリメントする。
    // これをしないと Cloudflare Queue 側の max_retries で暗黙に drop/DLQ されたとき、
    // このアプリの delivery 行が markFailed(dead:true) を一度も経ずに 'pending' のまま
    // 永久に取り残されてしまう。
    await store.markFailed(deliveryId, result.message, { dead: false });
    message.retry(
      result.retryAfterSeconds !== null ? { delaySeconds: result.retryAfterSeconds } : undefined,
    );
    return;
  }

  if (isPermanentFailure(result.status)) {
    // 例: webhook 削除 (404) 等、リトライしても回復しない失敗
    await store.markFailed(deliveryId, result.message, { dead: true });
    message.ack();
    return;
  }

  // 5xx / ネットワークエラー等、リトライ可能な失敗
  await store.markFailed(deliveryId, result.message, { dead: false });
  message.retry();
}

/**
 * Notify Queue のメッセージバッチを処理する。
 * 1件の失敗（想定外の例外を含む）が他件の処理を妨げないよう、メッセージ単位で独立して処理する。
 */
export async function processNotifyBatch(
  batch: NotifyMessageBatch,
  store: NotifyStore,
  opts: ProcessNotifyBatchOptions = {},
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processOne(message, store, opts);
    } catch (err) {
      // 想定外の例外 (store 側の障害等)。メッセージを失わないよう再配送に回す。
      // deliveryId のみを含む構造化ログを残す (webhook URL はこの時点で持っていないため
      // 漏えいの心配は無いが、念のためエラーオブジェクト全体ではなく message のみを載せる)。
      console.error('notify batch: unexpected error while processing delivery', {
        deliveryId: message.body.deliveryId,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        message.retry();
      } catch {
        // retry() 自体が失敗しても他メッセージの処理は継続する。
      }
    }
  }
}

export { maskWebhookUrl } from './discord';
