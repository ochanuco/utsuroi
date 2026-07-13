/**
 * rss / atom の Item 処理 (SPEC §6, §17.8-9)。
 *
 * sitemap / sitemap-index Source は既定で processSitemapDirect (ADR-0010 Phase A) へ、
 * config.sitemapMode === 'traverse' なら processSitemapTraversal (Phase B,
 * src/pipeline/sitemapTraversal.ts) へディスパッチされ、本ファイルの processFeedContent は
 * もはや呼ばれない (runCheck.ts 参照)。processFeedItems はいずれの sitemap 経路からも
 * 実URLの Target化・new/updated 検知・通知に再利用されるため、本体は残す。
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
import { checkUrlForSsrf } from '../net';
import {
  createSnapshot,
  insertChangeIfNew,
  upsertTarget,
  setTargetLastChecked,
  type TargetRow,
} from '../db';
import { bodyKey, putIfAbsent } from './r2';
import { notifyDetectedChanges, type DetectedChange } from './notify';
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

export interface ExistingTargetWatermark {
  exists: boolean;
  /** upsertTarget を呼ぶ前の (=このチェックで item.updatedAt を書き込む前の) watermark 値 */
  lastKnownUpdatedAt: string | null;
}

/**
 * 既存 Target の有無と、upsert 前時点の last_known_updated_at watermark を1クエリで取得する。
 * isNew 判定と 'updated' Change 判定 (watermark との比較) の両方に使う (migrations/0005)。
 * sitemapTraversal.ts (ADR-0010 Phase B) の子Sitemap watermark ゲートからも再利用するため export する。
 */
export async function getExistingTargetWatermark(
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

/** processFeedItems の戻り値。呼び出し側 (sitemapTraversal.ts) が打ち切り件数を検査できるようにする */
export interface ProcessFeedItemsResult {
  /** MAX_FEED_ITEMS_PER_CHECK (または注入値) 超過で処理しなかった件数。打ち切りが無ければ 0 */
  truncatedCount: number;
}

export interface ProcessFeedItemsOptions {
  /**
   * true の場合のみ、insertChangeIfNew ('new'/'updated' 双方) に
   * diffPreview: item.summary を渡す (ADR-0013)。既定 false — pageItems.ts (アイテム抽出モード)
   * 経由の呼び出しだけが true を渡し、rss/atom アダプタ等の通知内容は変更しない
   * (summary はHTML断片や長文になり得るため、一般化はサニタイズ・上限設計とセットで将来判断する)。
   */
  summaryAsDiffPreview?: boolean;
}

/** detectFeedChanges の戻り値。Notify段 (notifyDetectedChanges) にそのまま渡す。 */
interface DetectFeedChangesResult {
  /** item 処理順に積んだ検出結果。baseline チェックや skip のみだった場合は空配列。 */
  detected: DetectedChange[];
  truncatedCount: number;
}

/**
 * Detect段 (ADR-0016): rss/atom/sitemap の item 一覧を Target 化し、新規/更新を検出する。
 * Change の挿入 (insertChangeIfNew) までを担当し、fanout・changeIds 追加・watermark 前進は
 * 一切行わない — それらは Notify段 (notify.ts の notifyDetectedChanges) が detected を
 * item 処理順に消費して行う (processFeedItems 参照)。
 *
 * @param maxItems 1回の呼び出しで処理する item 数の上限 (既定 MAX_FEED_ITEMS_PER_CHECK)。
 *   超過分はスキップし (target/change を作らない)、次回以降のチェックに持ち越される。
 *   テストで小さい値を注入できるよう引数化している。
 */
async function detectFeedChanges(
  ctx: CheckContext,
  items: FeedItem[],
  maxItems: number,
  opts: ProcessFeedItemsOptions,
): Promise<DetectFeedChangesResult> {
  const nowIso = new Date(ctx.now()).toISOString();

  // monitor の初回チェックか否か。ctx.monitor は runMonitorCheck 冒頭で読み込まれた
  // スナップショットで、lastCheckedAt はこのチェック中に更新されない (setMonitorLastChecked は
  // finishJob 内、feed 処理より後に呼ばれる) ため、この判定はチェック全体を通じて安定する。
  const isBaselineCheck = ctx.monitor.lastCheckedAt === null;

  const truncated = items.length > maxItems;
  const toProcess = truncated ? items.slice(0, maxItems) : items;
  const truncatedCount = truncated ? items.length - toProcess.length : 0;
  if (truncated) {
    console.warn(
      `[feed] processFeedItems: monitor=${ctx.monitor.id} item count ${items.length} exceeds ` +
        `maxItems=${maxItems}; processing first ${toProcess.length}, skipping ${truncatedCount} ` +
        `(carried over to a future check)`,
    );
  }

  const detected: DetectedChange[] = [];

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
        // ADR-0013: pageItems.ts 経由の呼び出しのみ opt-in (summaryAsDiffPreview) で
        // summary (fields整形結果) を diff_preview として通知に載せる。
        diffPreview: opts.summaryAsDiffPreview ? (item.summary ?? undefined) : undefined,
      });
      // 'new' は upsertTarget 時に初期 watermark を記録済みのため watermarkAdvance は不要。
      detected.push({ row: inserted.row, inserted: inserted.inserted });
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
        diffPreview: opts.summaryAsDiffPreview ? (item.summary ?? undefined) : undefined,
      });
      // watermark 前進は Change 挿入 (dedupeKey 重複による recovery を含む) + 通知試行の後に
      // のみ行う (Notify段の notifyDetectedChanges に委ねる)。ここで先に進めてしまうと、
      // Change 挿入後・通知完了前にクラッシュした場合の再試行が「既に処理済み」と誤認され、
      // at-least-once 復旧 (fanoutChange の再試行) が働かなくなってしまう。
      detected.push({
        row: inserted.row,
        inserted: inserted.inserted,
        watermarkAdvance: { targetId: target.id, updatedAt: item.updatedAt },
      });
    }
  }

  return { detected, truncatedCount };
}

/**
 * rss/atom/sitemap の item 一覧を Target 化し、新規/更新を検出して通知する。
 * Detect段 (detectFeedChanges) → Notify段 (notify.ts の notifyDetectedChanges) の順に呼ぶだけの
 * オーケストレータ (ADR-0016 Step 3)。Detect段が全 item の Change 挿入を先に済ませ、
 * Notify段がその結果を item 処理順に fanout → changeIds 追加 → watermark 前進する。
 * item 単位で完結していた分割前と最終的な DB 状態・Queue 送信集合・changeIds は同一になる。
 *
 * @param maxItems 1回の呼び出しで処理する item 数の上限 (既定 MAX_FEED_ITEMS_PER_CHECK)。
 *   超過分はスキップし (target/change を作らない)、次回以降のチェックに持ち越される。
 *   テストで小さい値を注入できるよう引数化している。
 * @returns truncatedCount。rss/atom 経路 (processFeedContent) は戻り値を無視してよいが、
 *   sitemapTraversal.ts の traverseChild は「打ち切りが発生した子は watermark を進めない」
 *   判断にこの値を使う (ADR-0010 §5「超過分は次回以降のチェックに持ち越す」に従うため)。
 */
export async function processFeedItems(
  ctx: CheckContext,
  items: FeedItem[],
  maxItems: number = MAX_FEED_ITEMS_PER_CHECK,
  opts: ProcessFeedItemsOptions = {},
): Promise<ProcessFeedItemsResult> {
  const { detected, truncatedCount } = await detectFeedChanges(ctx, items, maxItems, opts);
  await notifyDetectedChanges(ctx, detected);
  return { truncatedCount };
}

/**
 * feed 系 Source (rss/atom) の Source URL 本体取得後の処理。
 * 本文を R2 へ保存し (履歴用、SPEC §13)、parseSource で items を取り出して processFeedItems へ
 * 委譲する。sitemap/sitemap-index は ADR-0010 (Phase A: processSitemapDirect, Phase B:
 * processSitemapTraversal) に完全に置き換わっており、runCheck.ts はこの関数を rss/atom
 * source にのみ呼ぶ (呼び出し側のディスパッチ判定を参照)。
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

  await processFeedItems(ctx, parsed.items);
}
