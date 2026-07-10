/**
 * src/shared/contracts.ts の NotifyStore を実装する D1 版。
 * wave2 (src/notify/, Lane E) がこの createD1NotifyStore() の戻り値だけを利用する。
 */
import type { ChangeKind, SourceType } from '../shared/types';
import type { ChangeSummary, NotifyStore, PendingDelivery } from '../shared/contracts';
import { markDeliveryDelivered, markDeliveryFailed } from './deliveries';
import { decryptWebhookUrl } from './webhookCrypto';
import { nowIso, wasWritten } from './util';

/** claimed_at から this 経過していれば 'sending' のまま止まった claim を stale とみなし再取得可とする */
const CLAIM_STALE_MS = 5 * 60 * 1000;

interface PendingDeliveryQueryRow {
  delivery_id: string;
  delivery_status: string;
  attempt_count: number;
  webhook_url: string;
  change_id: string;
  kind: ChangeKind;
  source_type: SourceType;
  site_name: string;
  monitor_id: string;
  target_url: string;
  title: string | null;
  detected_at: string;
  diff_preview: string | null;
}

/**
 * Discord Webhook配送状態ストア。
 *
 * getPendingDelivery は「配送権利の原子的な claim」でもある: 呼び出しごとに
 * `status IN ('pending','failed')` (または claimed_at が stale な 'sending') の行だけを
 * 条件付き UPDATE で 'sending' へ遷移させ、実際に自分が遷移させられた場合のみ配送対象
 * として返す。これにより、同一 delivery を指す NOTIFY_QUEUE メッセージが重複配送
 * (Cloudflare Queues の at-least-once 配送、リトライ、同時実行等) されても、実際に
 * Discord へ POST するのは claim に成功した1呼び出しだけになる。
 *
 * null を返すのは以下の場合 (冪等性の要, ADR-0007):
 * - delivery_id が存在しない
 * - 既に 'delivered' 済み
 * - 'dead' (再試行を諦めた) 状態
 * - 他の呼び出しが既に claim 済み (status='sending' かつ claimed_at が stale でない)
 */
export function createD1NotifyStore(db: D1Database, webhookEncKey: string | undefined): NotifyStore {
  return {
    async getPendingDelivery(deliveryId: string): Promise<PendingDelivery | null> {
      // 暗号鍵未設定チェックは claim (UPDATE) より前に行う。後段で行うと、鍵が無いために
      // 結局 throw して処理を中断するだけの delivery を 'sending' へ遷移させてしまい、
      // (呼び出し元が再試行しても毎回同じ理由で失敗する一方) claimed_at が更新され続けて
      // 他のワーカーからの正常な再試行機会を奪う (CLAIM_STALE_MS 経過まで claim できない)。
      if (!webhookEncKey) {
        throw new Error('WEBHOOK_ENC_KEY is not configured; cannot decrypt webhook_url for delivery');
      }

      const now = nowIso();
      const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();

      const claim = await db
        .prepare(
          `UPDATE deliveries
             SET status = 'sending', claimed_at = ?, updated_at = ?
           WHERE id = ?
             AND (status IN ('pending', 'failed') OR (status = 'sending' AND claimed_at < ?))`
        )
        .bind(now, now, deliveryId, staleBefore)
        .run();

      if (!wasWritten(claim)) return null;

      const row = await db
        .prepare(
          `SELECT
             d.id AS delivery_id,
             d.status AS delivery_status,
             d.attempt_count AS attempt_count,
             dest.webhook_url AS webhook_url,
             c.id AS change_id,
             c.kind AS kind,
             c.monitor_id AS monitor_id,
             c.target_url AS target_url,
             c.title AS title,
             c.detected_at AS detected_at,
             c.diff_preview AS diff_preview,
             src.type AS source_type,
             s.name AS site_name
           FROM deliveries d
           JOIN destinations dest ON dest.id = d.destination_id
           JOIN changes c ON c.id = d.change_id
           JOIN monitors m ON m.id = c.monitor_id
           JOIN sources src ON src.id = m.source_id
           JOIN sites s ON s.id = m.site_id
           WHERE d.id = ?`
        )
        .bind(deliveryId)
        .first<PendingDeliveryQueryRow>();

      // claim (UPDATE) が成功した直後なので理論上 null にはならないが、防御的に扱う。
      if (!row) return null;

      const webhookUrl = await decryptWebhookUrl(row.webhook_url, webhookEncKey);

      const change: ChangeSummary = {
        changeId: row.change_id,
        kind: row.kind,
        sourceType: row.source_type,
        siteName: row.site_name,
        monitorId: row.monitor_id,
        targetUrl: row.target_url,
        title: row.title,
        detectedAt: row.detected_at,
        diffPreview: row.diff_preview,
      };

      return {
        deliveryId: row.delivery_id,
        change,
        webhookUrl,
        attemptCount: row.attempt_count,
      };
    },

    async markDelivered(deliveryId: string): Promise<void> {
      await markDeliveryDelivered(db, deliveryId);
    },

    async markFailed(deliveryId: string, error: string, opts: { dead: boolean }): Promise<void> {
      await markDeliveryFailed(db, deliveryId, error, opts);
    },
  };
}
