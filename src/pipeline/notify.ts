/**
 * Change の subscription マッチ + delivery 作成 + NOTIFY_QUEUE enqueue (ADR-0016 Notify段)。
 *
 * feed.ts (rss/atom/sitemap traversal 経由の item 検知)、pageContent.ts (page 本文差分)、
 * sitemapDirect.ts (Sitemap Direct URL 集合差分) の3箇所で全く同じパターンが重複実装されて
 * いたため、この1関数へ統合した (ADR-0016 の第一歩、Source Pipeline の Notify 段分離)。
 * 挙動は統合前と完全に同一 — kind は呼び出し元が渡す change.kind をそのまま使う
 * (pageContent.ts / sitemapDirect.ts はいずれも kind: 'updated' の Change のみを渡すため、
 * 統合前にハードコードしていた 'updated' と結果は一致する)。
 */
import { createDeliveryIfNew, listMatchingSubscriptions, type ChangeRow } from '../db';
import type { CheckContext } from './types';

/**
 * change の subscription マッチ + delivery 作成 + NOTIFY_QUEUE enqueue を行う。
 * createDeliveryIfNew は冪等 (insert-if-new) なので、insertChangeIfNew が
 * dedupeKey 重複 (inserted:false) を返した場合でも安全に呼べる — 前回実行が
 * change 挿入後・delivery/enqueue 前にクラッシュしたケースの at-least-once 復旧のため、
 * 呼び出し側は inserted の真偽に関わらず常にこの関数を呼ぶこと (changeIds への追加は
 * 呼び出し側で inserted.inserted の場合のみ行う)。
 */
export async function fanoutChange(ctx: CheckContext, change: ChangeRow): Promise<void> {
  const subs = await listMatchingSubscriptions(ctx.db, {
    siteId: ctx.site.id,
    monitorId: ctx.monitor.id,
    kind: change.kind,
  });
  for (const sub of subs) {
    const delivery = await createDeliveryIfNew(ctx.db, change.id, sub.destinationId);
    if (delivery.inserted) {
      await ctx.env.NOTIFY_QUEUE.send({ deliveryId: delivery.row.id });
    }
  }
}
