/**
 * rss / atom / sitemap / sitemap-index の Item/子Sitemap 処理 (SPEC §6, §17.8-9)。
 *
 * 冪等性の要: dedupeKey が既知の値と同一なら insertChangeIfNew は no-op を返す。
 * - 新規 Target 発見時: dedupeKey = stableKey → 'new' Change (2回目以降の同一 stableKey は無視)
 * - 既存 Target で updatedAt を確認できる場合: Target の watermark (last_known_updated_at,
 *   migrations/0005_target_updated_watermark.sql) と実際に異なる場合のみ dedupeKey =
 *   `${stableKey}:${updatedAt}` → 'updated' Change (dedupeKey 自体も同じ値の再チェックでは
 *   no-op になる保険として維持)。watermark は新規 Target 発見時に初期値を記録し、既存 Target では
 *   'updated' Change の挿入・通知試行が完了した後にのみ進める (crash 後の at-least-once 復旧を
 *   壊さないため、詳細は processFeedItems 内のコメント参照)。
 * RSS は仕様上 updatedAt を持たないため (src/adapters/rss.ts)、既存 entry の再取得では 'updated' を作らない。
 *
 * 初回ベースライン化 (SPEC §12 の page 側原則を feed 側にも適用):
 * monitor の初回チェック (ctx.monitor.lastCheckedAt === null) では、発見した URL を Target として
 * 全件 upsert するが Change は一切作らない (baseline 確立のみ)。sitemap-index の親経由で最初に
 * 監視を始めた場合、既存の全 URL がその瞬間 "新規" に見えてしまい、初回だけで数千件の 'new' Change /
 * 通知が生成される実障害 (Workers 実行時間/サブリクエスト上限超過→ check_job が 'running' のまま
 * デッドロック) が起きたための対策。ctx.monitor は runMonitorCheck 冒頭で一度読み込まれたきりで
 * lastCheckedAt はチェック中に書き換わらない (setMonitorLastChecked は finishJob 内、feed 処理の後に
 * 呼ばれる) ため、この判定はチェック全体を通じて安定している。
 *
 * URL 処理上限 (MAX_FEED_ITEMS_PER_CHECK, 既定 2000):
 * 1回の processFeedItems 呼び出しで処理する item 数を上限で打ち切る (silent truncation 禁止,
 * ADR-0005 Guardrail 「Attempt数とコストに上限」の精神)。上限は baseline チェックでも変更検知
 * チェックでも同じ値を使う。baseline 中に上限超過で処理されなかった URL は、次回チェックで改めて
 * "新規" として現れる — その時点では baseline を終えている (lastCheckedAt が非 null) ため、
 * それらの残り分は 'new' Change として検知・通知される。1つの sitemap の残余 URL 数を数回の
 * チェックに分割して吸収する設計として意図的に許容している (上限を十分大きくすることで実質
 * 1サイトを1〜数回のチェックで吸収できる想定)。
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
  setTargetLastKnownUpdatedAt,
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

/**
 * processFeedItems 1回の呼び出しで処理する item (URL) 数の既定上限。
 * sitemap-index の子 sitemap 1つに数千 URL が含まれるケース (実障害: www.hira2.jp で
 * 5,183件を1回で処理し Workers の実行時間/サブリクエスト上限を超過) に対するガード。
 * 呼び出し側 (processFeedItems の第3引数) で上書き可能 — テストで小さい値を注入するため。
 */
export const MAX_FEED_ITEMS_PER_CHECK = 2000;

interface ExistingTargetWatermark {
  exists: boolean;
  /** upsertTarget を呼ぶ前の (=このチェックで item.updatedAt を書き込む前の) watermark 値 */
  lastKnownUpdatedAt: string | null;
}

/**
 * 既存 Target の有無と、upsert 前時点の last_known_updated_at watermark を1クエリで取得する。
 * isNew 判定と 'updated' Change 判定 (watermark との比較) の両方に使う (migrations/0005)。
 */
async function getExistingTargetWatermark(
  db: D1Database,
  monitorId: string,
  url: string,
): Promise<ExistingTargetWatermark> {
  const row = await db
    .prepare(`SELECT last_known_updated_at FROM targets WHERE monitor_id = ? AND url = ? LIMIT 1`)
    .bind(monitorId, url)
    .first<{ last_known_updated_at: string | null }>();
  return row
    ? { exists: true, lastKnownUpdatedAt: row.last_known_updated_at ?? null }
    : { exists: false, lastKnownUpdatedAt: null };
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

/**
 * rss/atom/sitemap の item 一覧を Target 化し、新規/更新を検出して通知する。
 *
 * @param maxItems 1回の呼び出しで処理する item 数の上限 (既定 MAX_FEED_ITEMS_PER_CHECK)。
 *   超過分はスキップし (target/change を作らない)、次回以降のチェックに持ち越される。
 *   テストで小さい値を注入できるよう引数化している。
 */
export async function processFeedItems(
  ctx: CheckContext,
  items: FeedItem[],
  maxItems: number = MAX_FEED_ITEMS_PER_CHECK,
): Promise<void> {
  const nowIso = new Date(ctx.now()).toISOString();

  // monitor の初回チェックか否か。ctx.monitor は runMonitorCheck 冒頭で読み込まれた
  // スナップショットで、lastCheckedAt はこのチェック中に更新されない (setMonitorLastChecked は
  // finishJob 内、feed 処理より後に呼ばれる) ため、この判定はチェック全体を通じて安定する。
  const isBaselineCheck = ctx.monitor.lastCheckedAt === null;

  const truncated = items.length > maxItems;
  const toProcess = truncated ? items.slice(0, maxItems) : items;
  if (truncated) {
    console.warn(
      `[feed] processFeedItems: monitor=${ctx.monitor.id} item count ${items.length} exceeds ` +
        `maxItems=${maxItems}; processing first ${toProcess.length}, skipping ${items.length - toProcess.length} ` +
        `(carried over to a future check)`,
    );
  }

  for (const item of toProcess) {
    // FeedItem.url が無い entry は Target (UNIQUE(monitor_id, url)) を作れないためスキップする。
    if (!item.url) continue;

    // item URL にも sitemap-index の子 sitemap と同じ URL ポリシー検査 (SSRF) を適用する。
    // item URL 自体をこのパイプラインが取得 (fetch) することは無い (メタデータとして
    // 保存するのみ) ため、resolveAndCheck (DNS解決を伴う動的検査) や robots 評価は行わず
    // 静的検査のみで十分と判断する。拒否された URL は target/change を作らずスキップする。
    const itemSsrf = checkUrlForSsrf(item.url);
    if (!itemSsrf.allowed) continue;

    const previous = await getExistingTargetWatermark(ctx.db, ctx.monitor.id, item.url);
    const isNew = !previous.exists;
    const target = await upsertTarget(ctx.db, {
      monitorId: ctx.monitor.id,
      url: item.url,
      discoveredFrom: item.stableKey,
      // 新規 Target のみ item.updatedAt を初期 watermark として記録する (baseline チェックでの
      // 基準値確定を含む)。既存 Target の watermark はここでは触らない — 'updated' Change の
      // 検出・通知試行が完了した後にのみ進める (下記コメント参照。crash 後の at-least-once
      // 復旧を壊さないため)。
      lastKnownUpdatedAt: isNew ? item.updatedAt : undefined,
    });
    await setTargetLastChecked(ctx.db, target.id, nowIso);

    // 初回チェックは baseline 確立のみ: Target は登録するが Change は一切作らない
    // (SPEC §12 の page 初回 snapshot 原則を feed 側にも適用)。
    if (isBaselineCheck) continue;

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
    // 判定は Target の watermark (last_known_updated_at, upsertTarget 呼び出し前の値) との
    // 直接比較で行う — Change テーブルの dedupeKey 存在有無だけに頼ると、baseline チェックは
    // Change を一切作らないため、baseline 後の最初の非baselineチェックで「lastmod が変わって
    // いない既存 URL 全部」が dedupeKey 未見扱いになり 'updated' が誤って大量発火してしまう
    // (migrations/0005_target_updated_watermark.sql で追加した watermark 列により解消)。
    // dedupeKey に updatedAt を含めることも維持し、同じ値の再チェックが万一発生しても no-op になる
    // 保険 (at-least-once 復旧) を残す。
    if (item.updatedAt && item.updatedAt !== previous.lastKnownUpdatedAt) {
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
      // watermark は Change 挿入 (dedupeKey 重複による recovery を含む) + 通知試行の後にのみ進める。
      // ここより前に (例えば upsertTarget 呼び出し時点で) 無条件に進めてしまうと、Change 挿入後・
      // 通知完了前にクラッシュした場合の再試行が「既に処理済み」と誤認され、at-least-once 復旧
      // (notifyForChange の再試行) が働かなくなってしまう。
      await setTargetLastKnownUpdatedAt(ctx.db, target.id, item.updatedAt);
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
