/**
 * src/shared/contracts.ts の NotifyStore を実装する D1 版。
 * wave2 (src/notify/, Lane E) がこの createD1NotifyStore() の戻り値だけを利用する。
 */
import type { ChangeKind, SourceType } from '../shared/types';
import type { ChangeSummary, NotifyStore, PendingDelivery } from '../shared/contracts';
import { markDeliveryDelivered, markDeliveryFailed } from './deliveries';

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
 * getPendingDelivery は以下の場合に null を返す (冪等性の要, ADR-0007):
 * - delivery_id が存在しない
 * - 既に 'delivered' 済み
 * - 'dead' (再試行を諦めた) 状態
 * 'pending' および 'failed' (再試行対象) は配送対象として返す。
 */
export function createD1NotifyStore(db: D1Database): NotifyStore {
  return {
    async getPendingDelivery(deliveryId: string): Promise<PendingDelivery | null> {
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

      if (!row) return null;
      if (row.delivery_status === 'delivered' || row.delivery_status === 'dead') return null;

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
        webhookUrl: row.webhook_url,
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
