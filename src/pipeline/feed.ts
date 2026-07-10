/**
 * rss / atom / sitemap / sitemap-index の Item/子Sitemap 処理 (SPEC §6, §17.8-9)。
 *
 * 冪等性の要: dedupeKey が既知の値と同一なら insertChangeIfNew は no-op を返す。
 * - 新規 Target 発見時: dedupeKey = stableKey → 'new' Change (2回目以降の同一 stableKey は無視)
 * - 既存 Target で updatedAt を確認できる場合: dedupeKey = `${stableKey}:${updatedAt}` → 'updated' Change
 *   (updatedAt が変わらない限り同じ dedupeKey になるため、再チェックしても重複通知しない)
 * RSS は仕様上 updatedAt を持たないため (src/adapters/rss.ts)、既存 entry の再取得では 'updated' を作らない。
 */
import { parseSource } from '../adapters';
import { AdapterParseError } from '../adapters/errors';
import type { FeedItem } from '../shared/contracts';
import type { FetchSuccess } from '../shared/contracts';
import { sha256Hex } from '../shared/hash';
import { extractCharsetFromContentType } from '../normalize';
import { checkRobots } from '../robots';
import { checkUrlForSsrf, resolveAndCheck } from '../net';
import {
  createDeliveryIfNew,
  createSnapshot,
  insertChangeIfNew,
  listMatchingSubscriptions,
  upsertTarget,
  setTargetLastChecked,
  getLatestSnapshotForTarget,
  getRobotsMode,
  type ChangeRow,
  type TargetRow,
} from '../db';
import { bodyKey, putIfAbsent } from './r2';
import { createD1RobotsCache } from './robotsCache';
import { fetchTargetThroughPolicy } from './fetchTarget';
import type { CheckContext } from './types';

/** Sitemap Index 配下の子 Sitemap の取得上限 (1回のチェックあたり) */
export const MAX_CHILD_SITEMAPS = 20;

async function targetExists(db: D1Database, monitorId: string, url: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 FROM targets WHERE monitor_id = ? AND url = ? LIMIT 1`)
    .bind(monitorId, url)
    .first();
  return row !== null;
}

/**
 * change の subscription マッチ + delivery 作成 + NOTIFY_QUEUE enqueue を行う。
 * createDeliveryIfNew は冪等 (insert-if-new) なので、insertChangeIfNew が
 * dedupeKey 重複 (inserted:false) を返した場合でも安全に呼べる — 前回実行が
 * change 挿入後・delivery/enqueue 前にクラッシュしたケースの at-least-once 復旧のため、
 * 呼び出し側は inserted の真偽に関わらず常にこの関数を呼ぶこと (changeIds への追加は
 * 呼び出し側で inserted.inserted の場合のみ行う)。
 */
async function notifyForChange(ctx: CheckContext, change: ChangeRow): Promise<void> {
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

/** rss/atom/sitemap の item 一覧を Target 化し、新規/更新を検出して通知する */
export async function processFeedItems(ctx: CheckContext, items: FeedItem[]): Promise<void> {
  const nowIso = new Date(ctx.now()).toISOString();

  for (const item of items) {
    // FeedItem.url が無い entry は Target (UNIQUE(monitor_id, url)) を作れないためスキップする。
    if (!item.url) continue;

    // item URL にも sitemap-index の子 sitemap と同じ URL ポリシー検査 (SSRF) を適用する。
    // item URL 自体をこのパイプラインが取得 (fetch) することは無い (メタデータとして
    // 保存するのみ) ため、resolveAndCheck (DNS解決を伴う動的検査) や robots 評価は行わず
    // 静的検査のみで十分と判断する。拒否された URL は target/change を作らずスキップする。
    const itemSsrf = checkUrlForSsrf(item.url);
    if (!itemSsrf.allowed) continue;

    const isNew = !(await targetExists(ctx.db, ctx.monitor.id, item.url));
    const target = await upsertTarget(ctx.db, {
      monitorId: ctx.monitor.id,
      url: item.url,
      discoveredFrom: item.stableKey,
    });
    await setTargetLastChecked(ctx.db, target.id, nowIso);

    if (isNew) {
      const inserted = await insertChangeIfNew(ctx.db, {
        monitorId: ctx.monitor.id,
        targetId: target.id,
        targetUrl: item.url,
        kind: 'new',
        dedupeKey: item.stableKey,
        title: item.title,
        detectedAt: nowIso,
      });
      await notifyForChange(ctx, inserted.row);
      if (inserted.inserted) ctx.changeIds.push(inserted.row.id);
      continue;
    }

    // 既存 Target: updatedAt が確認できる Source (atom/sitemap) のみ 'updated' を検出できる。
    // dedupeKey に updatedAt を含めることで、同じ値の再チェックは自動的に no-op になる。
    if (item.updatedAt) {
      const inserted = await insertChangeIfNew(ctx.db, {
        monitorId: ctx.monitor.id,
        targetId: target.id,
        targetUrl: item.url,
        kind: 'updated',
        dedupeKey: `${item.stableKey}:${item.updatedAt}`,
        title: item.title,
        detectedAt: nowIso,
      });
      await notifyForChange(ctx, inserted.row);
      if (inserted.inserted) ctx.changeIds.push(inserted.row.id);
    }
  }
}

/**
 * feed 系 Source (rss/atom/sitemap/sitemap-index) の Source URL 本体取得後の処理。
 * 本文を R2 へ保存し (履歴用、SPEC §13)、parseSource で items/childSitemaps を取り出して
 * processFeedItems / processSitemapIndexChildren へ委譲する。
 */
export async function processFeedContent(
  ctx: CheckContext,
  target: TargetRow,
  checkAttemptId: string | null,
  outcome: FetchSuccess,
  body: Uint8Array,
): Promise<void> {
  const rawHash = await sha256Hex(body);
  await putIfAbsent(ctx.env.BODIES, bodyKey(rawHash), body);

  // createSnapshot / 成功確定は parseSource が成功した後にのみ行う。パース不能な本文を
  // 「正常に取り込めた Snapshot」として記録してしまうと、以降の diff/変更検知の前提が
  // 崩れるため。AdapterParseError (parse_error) はフェッチ自体は成功として扱いつつ
  // (attempt は既に success で記録済み) Snapshot を作らず items 処理もスキップする。
  // それ以外の想定外例外は握りつぶさずそのまま再送出する。
  let parsed;
  try {
    parsed = parseSource(ctx.source.type, body, {
      baseUrl: ctx.source.url,
      headerCharset: extractCharsetFromContentType(outcome.contentType),
    });
  } catch (err) {
    if (err instanceof AdapterParseError) return;
    throw err;
  }

  await createSnapshot(ctx.db, {
    monitorId: ctx.monitor.id,
    targetId: target.id,
    checkAttemptId,
    fetchedAt: new Date(ctx.now()).toISOString(),
    httpStatus: outcome.status,
    contentType: outcome.contentType,
    etag: outcome.etag,
    lastModified: outcome.lastModified,
    bodyHash: rawHash,
    r2Key: bodyKey(rawHash),
  });

  if (ctx.source.type === 'sitemap-index') {
    await processSitemapIndexChildren(ctx, parsed.childSitemaps);
    if (parsed.items.length > 0) await processFeedItems(ctx, parsed.items);
  } else {
    await processFeedItems(ctx, parsed.items);
  }
}

/**
 * Sitemap Index 配下の子 Sitemap を取得・展開する。
 * 設計判断 (ADR-0005 Guardrail「同一originは取得間で追加leaseは不要とする」に基づく簡略化):
 * - 子 Sitemap の取得には追加の HostObject lease を取らない (親の取得で確保した枠内とみなす)。
 * - 子ごとに SSRF / robots を個別評価するが、disallowed/blocked の子は Monitor 全体を
 *   Policy Stop せずスキップする (Source URL 自体は既に許可されているため)。
 * - 孫 sitemap-index (入れ子) の再帰展開は MVP スコープ外。
 */
export async function processSitemapIndexChildren(
  ctx: CheckContext,
  childSitemaps: string[],
): Promise<void> {
  const children = childSitemaps.slice(0, MAX_CHILD_SITEMAPS);

  for (const childUrl of children) {
    const staticCheck = checkUrlForSsrf(childUrl);
    if (!staticCheck.allowed) continue;
    const dynamicCheck = await resolveAndCheck(childUrl, { fetchImpl: ctx.fetchImpl });
    if (!dynamicCheck.allowed) continue;

    let origin: string;
    try {
      origin = new URL(childUrl).origin;
    } catch {
      continue;
    }

    const robotsMode = await getRobotsMode(ctx.db, ctx.site.id, origin);
    const decision = await checkRobots(origin, childUrl, {
      fetchImpl: ctx.fetchImpl,
      userAgent: ctx.env.USER_AGENT,
      cache: createD1RobotsCache(ctx.db),
      now: ctx.now,
    });
    if (decision.verdict === 'disallowed' && robotsMode === 'enforce') continue;

    const childTarget = await upsertTarget(ctx.db, {
      monitorId: ctx.monitor.id,
      url: childUrl,
      discoveredFrom: 'sitemap-index',
    });

    const latest = await getLatestSnapshotForTarget(ctx.db, childTarget.id);
    const { outcome } = await fetchTargetThroughPolicy(ctx, childTarget.id, childUrl, {
      etag: latest?.etag ?? null,
      lastModified: latest?.lastModified ?? null,
    });
    // フェッチ自体が失敗した場合のみ last_checked_at を更新せずスキップする。
    // 304 Not Modified は「子 Sitemap の正常なチェック」なので last_checked_at は更新する
    // (パースする新規本文が無いため items 処理だけスキップする)。
    if (!outcome.ok) continue;
    const checkedAtIso = new Date(ctx.now()).toISOString();
    if (outcome.notModified || !outcome.body) {
      await setTargetLastChecked(ctx.db, childTarget.id, checkedAtIso);
      continue;
    }

    let parsed;
    try {
      parsed = parseSource('sitemap', outcome.body, {
        baseUrl: childUrl,
        headerCharset: extractCharsetFromContentType(outcome.contentType),
      });
    } catch {
      continue;
    }
    await setTargetLastChecked(ctx.db, childTarget.id, checkedAtIso);
    await processFeedItems(ctx, parsed.items);
  }
}
