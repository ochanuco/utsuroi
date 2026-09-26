/**
 * src/shared/contracts.ts の NotifyStore を実装する D1 版。
 * wave2 (src/notify/, Lane E) がこの createD1NotifyStore() の戻り値だけを利用する。
 */
import type { ChangeKind, SourceType } from '../shared/types';
import type { ChangeSummary, NotifyStore, PendingDelivery, TagLine } from '../shared/contracts';
import { markDeliveryDelivered, markDeliveryFailed } from './deliveries';
import type { SourceConfig } from './types';
import { decryptWebhookUrl } from './webhookCrypto';
import { nowIso, parseJson, wasWritten } from './util';

/** claimed_at から this 経過していれば 'sending' のまま止まった claim を stale とみなし再取得可とする */
const CLAIM_STALE_MS = 5 * 60 * 1000;

/** classify.labels.groups に見出しが無いグループ (またはグループ自体が未設定) に使う既定見出し */
const DEFAULT_GROUP_HEADING = '分類';

interface PendingDeliveryQueryRow {
  delivery_id: string;
  delivery_status: string;
  attempt_count: number;
  webhook_url: string;
  destination_archived_at: string | null;
  destination_thread_id: string | null;
  change_id: string;
  kind: ChangeKind;
  source_type: SourceType;
  site_name: string;
  monitor_id: string;
  target_url: string;
  title: string | null;
  detected_at: string;
  diff_preview: string | null;
  change_tags: string | null;
  source_config: string | null;
}

/**
 * Change のタグを classify.labels (ADR-0019 labels機能) で解決し、Discord embed に載せる
 * グループ別の表示行へ変換する。discord.ts は純粋なフォーマッタに留めるため、DB から読める
 * classify.labels を使う解決ロジックはここ (データを読み出す側) に置く。
 *
 * - グループ化は各タグの先頭コロン前 (prefix) で行う (コロンが無いタグは group key '')。
 * - グループの出現順は tags 内での初出順、各グループ内の値順はタグの並び順を維持する。
 * - heading は labels.groups[prefix] ?? '分類'、value は labels.tags[tag] ?? tag (生値)。
 * - tags が null または空配列なら空配列を返す (表示行なし)。
 */
/** `constructor` など Object.prototype 由来のキーを表示名として拾わないよう、自身のキーだけを引く */
function ownLabel(map: Record<string, string> | undefined, key: string): string | undefined {
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}

export function resolveTagLines(
  tags: string[] | null,
  labels: NonNullable<SourceConfig['classify']>['labels'],
): TagLine[] {
  if (!tags || tags.length === 0) return [];

  const order: string[] = [];
  const valuesByGroup = new Map<string, string[]>();
  for (const tag of tags) {
    const sep = tag.indexOf(':');
    const groupKey = sep === -1 ? '' : tag.slice(0, sep);
    if (!valuesByGroup.has(groupKey)) {
      valuesByGroup.set(groupKey, []);
      order.push(groupKey);
    }
    valuesByGroup.get(groupKey)!.push(ownLabel(labels?.tags, tag) ?? tag);
  }

  return order.map((groupKey) => ({
    heading: ownLabel(labels?.groups, groupKey) ?? DEFAULT_GROUP_HEADING,
    values: valuesByGroup.get(groupKey)!,
  }));
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
 * - claim 対象の Destination がアーカイブ済み (ADR-0012, claim 後に 'dead' へ倒して返す)
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
             dest.archived_at AS destination_archived_at,
             dest.thread_id AS destination_thread_id,
             c.id AS change_id,
             c.kind AS kind,
             c.monitor_id AS monitor_id,
             c.target_url AS target_url,
             c.title AS title,
             c.detected_at AS detected_at,
             c.diff_preview AS diff_preview,
             c.tags AS change_tags,
             src.type AS source_type,
             src.config AS source_config,
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

      // アーカイブ済み Destination (ADR-0012) の delivery: アーカイブ操作は webhook_url を
      // 破棄しているため復号を試みても無意味 (かつ空文字の復号は失敗する)。アーカイブ前に
      // enqueue 済みだった NOTIFY_QUEUE メッセージ対策として、claim 済みの delivery を
      // 'dead' に倒して null を返す (再試行させない)。
      if (row.destination_archived_at !== null) {
        await markDeliveryFailed(db, deliveryId, 'destination archived', { dead: true });
        return null;
      }

      const webhookUrl = await decryptWebhookUrl(row.webhook_url, webhookEncKey);

      // labels機能 (ADR-0019): Change のタグを Source の classify.labels で解決し、
      // Discord embed 用のグループ別表示行を組み立てる。Source に classify (または labels) が
      // 未設定なら labels は undefined になり、resolveTagLines は生タグのままの表示行を返す。
      const tags = parseJson<string[] | null>(row.change_tags, null);
      const sourceConfig = parseJson<SourceConfig | null>(row.source_config, null);
      const tagLines = resolveTagLines(tags, sourceConfig?.classify?.labels);

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
        tags,
        tagLines,
      };

      return {
        deliveryId: row.delivery_id,
        change,
        webhookUrl,
        attemptCount: row.attempt_count,
        threadId: row.destination_thread_id ?? null,
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
