/**
 * Sitemap 探索モード (ADR-0010 Phase B, docs/adr/0010-detection-chain-and-source-promotion.md 「モードB」)。
 *
 * sitemap-index Source の config.sitemapMode === 'traverse' のときにこのモジュールへ到達する
 * (既定は processSitemapDirect のまま、runCheck.ts のディスパッチ判定を参照)。
 *
 * 方針: 子 Sitemap の lastmod が前回チェックから変化したものだけを取得・再帰展開し、
 * urlset の実URL (loc) まで到達したら、その新規出現・lastmod更新を processFeedItems
 * (feed.ts) に委譲して Change として配信する (本文は取得しない)。processFeedItems は
 * すでに baseline 判定・upsertTarget・new/updated 検知・通知ファンアウトを一式持っている
 * ため、実URLの扱いはここで再実装しない。
 *
 * 歯止め (ADR-0010 §5, 「打ち切りは無言にせず記録する」):
 * - lastmod足切り (既定 DEFAULT_LASTMOD_MAX_AGE_DAYS 日): 対象外の実URL/子Sitemapは展開しない。
 * - 子Sitemap数上限 (MAX_CHILD_SITEMAPS, feed.ts の既定値を再利用): 超過分は打ち切る。
 * - 再帰深さ上限 (既定 DEFAULT_MAX_TRAVERSAL_DEPTH): 到達したら以降のネストは展開しない。
 * - origin境界: 親Siteのcanonical origin外の子Sitemapは展開しない。
 * - 実URL処理上限 (MAX_FEED_ITEMS_PER_CHECK, processFeedItems 側): 超過分は次回以降の
 *   チェックに持ち越す (この場合、超過を起こした子の watermark は進めない。下記コメント参照)。
 *
 * これらのうち実際に「作業を打ち切った」もの (childrenTruncated / depthTruncated /
 * feedItemsTruncated) はチェック終了時に console.warn + audit_events
 * (action: 'monitor.traversal_truncated') へまとめて1件記録する (無言で落とさない)。
 * originBlocked / missingLastmodSkipped は境界外/足切り対象の通常スキップであり定常的に
 * 発生しうるため、console.warn のみ (audit行の記録条件は recordTruncationIfAny 参照)。
 *
 * 実URLの updatedAt (lastmod) が無いエントリは、足切りの基準にできないため traverse モードでは
 * 常にスキップする (ADR-0010 「モードBはlastmodを信頼できるサイト向け」という前提そのもの)。
 */
import { parseSource } from '../adapters';
import { AdapterParseError } from '../adapters/errors';
import { checkRobots } from '../robots';
import { checkUrlForSsrf, resolveAndCheck } from '../net';
import { extractCharsetFromContentType } from '../normalize';
import type { AdapterParseResult, FeedItem, FetchSuccess } from '../shared/contracts';
import { sha256Hex } from '../shared/hash';
import {
  createSnapshot,
  getLatestSnapshotForTarget,
  getRobotsMode,
  recordAuditEvent,
  setTargetLastChecked,
  setTargetLastKnownUpdatedAt,
  upsertTarget,
  type TargetRow,
} from '../db';
import { bodyKey, putIfAbsent } from './r2';
import { createD1RobotsCache } from './robotsCache';
import { fetchTargetThroughPolicy } from './fetchTarget';
import { getExistingTargetWatermark, processFeedItems, MAX_CHILD_SITEMAPS } from './feed';
import type { CheckContext } from './types';

/** lastmod足切りの既定日数 (ADR-0010 §5) */
export const DEFAULT_LASTMOD_MAX_AGE_DAYS = 3;
/** sitemap-index 再帰展開の既定深さ上限 (ADR-0010 §5) */
export const DEFAULT_MAX_TRAVERSAL_DEPTH = 3;

/** チェック全体で集計する打ち切り・スキップ件数 (ADR-0010 §5「打ち切りは無言にせず記録する」) */
interface TraversalCounts {
  /** MAX_CHILD_SITEMAPS 超過で展開しなかった子Sitemap数 (sitemap-indexごとの合算) */
  childrenTruncated: number;
  /** 再帰深さ上限に達し展開しなかった子 sitemap-index 数 */
  depthTruncated: number;
  /** 親Siteのcanonical origin外だったため展開しなかった子Sitemap数 */
  originBlocked: number;
  /** updatedAt (lastmod) が無く足切り不能だったため無視した実URL数 */
  missingLastmodSkipped: number;
  /** processFeedItems 側 (MAX_FEED_ITEMS_PER_CHECK) で打ち切られ、次回以降に持ち越された実URL数 */
  feedItemsTruncated: number;
}

function newCounts(): TraversalCounts {
  return {
    childrenTruncated: 0,
    depthTruncated: 0,
    originBlocked: 0,
    missingLastmodSkipped: 0,
    feedItemsTruncated: 0,
  };
}

/**
 * items から「updatedAt が cutoff 以降かつ null でない」実URLだけを残す。
 * updatedAt が null のものは足切り不能なため件数をカウントしつつ常に除外する。
 */
function filterItemsForTraversal(items: FeedItem[], cutoffIso: string, counts: TraversalCounts): FeedItem[] {
  const kept: FeedItem[] = [];
  for (const item of items) {
    if (!item.url) continue; // processFeedItems 側でもスキップされるが早めに弾く
    if (item.updatedAt === null) {
      counts.missingLastmodSkipped += 1;
      continue;
    }
    if (item.updatedAt < cutoffIso) continue; // 足切り (打ち切りカウント対象ではない通常動作)
    kept.push(item);
  }
  return kept;
}

/**
 * 親Siteのcanonical origin (site.primaryOrigin) と一致するかどうかを判定する。
 * primaryOrigin が未設定、または childUrl が不正なURLの場合は安全側 (境界内とはみなさない) に倒す。
 */
function isWithinSiteOrigin(childUrl: string, primaryOrigin: string | null): boolean {
  if (!primaryOrigin) return false;
  try {
    return new URL(childUrl).origin === new URL(primaryOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * sitemap-index の子1件を評価・条件付き展開する。
 *
 * 呼び出し順序 (ADR-0010 §5, §3 に対応):
 * 1. origin境界 → 2. lastmod足切り → 3. Target upsert (watermark取得は upsert 前) →
 * 4. baseline (フェッチ・展開しない) → 5. watermark比較でのゲート →
 * 6. SSRF/robots (HostObject 追加leaseは取らない、feed.ts の既存設計判断を踏襲) →
 * 7. 条件付きフェッチ → 8. urlset なら processFeedItems、sitemap-index なら再帰 →
 * 9. 展開が正常完了した後にのみ watermark を前進 (at-least-once 復旧のため、feed.ts と同じ理由)。
 */
async function traverseChild(
  ctx: CheckContext,
  childUrl: string,
  childLastmod: string | null,
  depth: number,
  cutoffIso: string,
  maxDepth: number,
  counts: TraversalCounts,
): Promise<void> {
  // 1. origin境界 (ADR-0010 §5「親Siteのcanonical origin内に限定する」)。
  if (!isWithinSiteOrigin(childUrl, ctx.site.primaryOrigin)) {
    counts.originBlocked += 1;
    return;
  }

  // 2. lastmod足切り。lastmod が無い子はここでは弾かない (ゲート不能なので毎回条件付きフェッチする、
  // ADR-0010 §2 モードB「lastmodが無い場合は…」の裏側)。
  if (childLastmod !== null && childLastmod < cutoffIso) return;

  // 3. watermark はこの Target を upsert する前の値を見る (isNew 判定・ゲート判定の両方に使う)。
  const previous = await getExistingTargetWatermark(ctx.db, ctx.monitor.id, childUrl);
  const isNewChild = !previous.exists;
  const childTarget = await upsertTarget(ctx.db, {
    monitorId: ctx.monitor.id,
    url: childUrl,
    discoveredFrom: 'sitemap-index',
    // 新規Targetのみ子のlastmodを初期watermarkとして記録する (feed.ts processFeedItems と同じ規約)。
    lastKnownUpdatedAt: isNewChild ? childLastmod : undefined,
  });

  // 4. baseline: 子Targetの登録とwatermark初期化のみ行い、フェッチも展開もしない
  // (ADR-0010 §3「初回に子Sitemapのlastmodを記録し、実URLを一括展開しない」)。
  if (ctx.monitor.lastCheckedAt === null) {
    await setTargetLastChecked(ctx.db, childTarget.id, new Date(ctx.now()).toISOString());
    return;
  }

  // 5. watermarkゲート: 既存Targetで、かつ子のlastmodが前回と同一ならフェッチせずスキップする
  // (lastmodが無い子や新規に見つかった子はゲートできないため、常にこの先へ進み条件付きフェッチする)。
  if (!isNewChild && childLastmod !== null && previous.lastKnownUpdatedAt === childLastmod) {
    await setTargetLastChecked(ctx.db, childTarget.id, new Date(ctx.now()).toISOString());
    return;
  }

  // 6. SSRF (静的+動的) / robots 評価 (feed.ts の旧 processSitemapIndexChildren と同じ判断:
  // 子Sitemapの取得には追加の HostObject lease を取らない。親Source取得で確保した枠内とみなす簡略化、
  // ADR-0005 Guardrail「同一originは取得間で追加leaseは不要とする」に基づく)。
  const staticCheck = checkUrlForSsrf(childUrl);
  if (!staticCheck.allowed) return;
  const dynamicCheck = await resolveAndCheck(childUrl, { fetchImpl: ctx.fetchImpl });
  if (!dynamicCheck.allowed) return;

  let origin: string;
  try {
    origin = new URL(childUrl).origin;
  } catch {
    return;
  }
  const robotsMode = await getRobotsMode(ctx.db, ctx.site.id, origin);
  const decision = await checkRobots(origin, childUrl, {
    fetchImpl: ctx.fetchImpl,
    userAgent: ctx.env.USER_AGENT,
    cache: createD1RobotsCache(ctx.db),
    now: ctx.now,
  });
  if (decision.verdict === 'disallowed' && robotsMode === 'enforce') return;

  // 7. 条件付きフェッチ (etag/lastModified は既存Snapshotから)。
  const latest = await getLatestSnapshotForTarget(ctx.db, childTarget.id);
  const { outcome } = await fetchTargetThroughPolicy(ctx, childTarget.id, childUrl, {
    etag: latest?.etag ?? null,
    lastModified: latest?.lastModified ?? null,
  });
  // フェッチ自体が失敗した場合は last_checked_at を更新せずスキップする (次回リトライに委ねる)。
  if (!outcome.ok) return;

  const checkedAtIso = new Date(ctx.now()).toISOString();
  if (outcome.notModified || !outcome.body) {
    // 304等: 子Sitemapは正常にチェックできたが新規本文が無いため展開はスキップする。
    // 展開していない (=lastmodの変化を確認できていない) ため watermark は進めない。
    await setTargetLastChecked(ctx.db, childTarget.id, checkedAtIso);
    return;
  }

  // auto-detect: 子は urlset/sitemapindex のどちらもありうる (parseSource は実際のルート要素を見る)。
  let parsed: AdapterParseResult;
  try {
    parsed = parseSource('sitemap', outcome.body, {
      baseUrl: childUrl,
      headerCharset: extractCharsetFromContentType(outcome.contentType),
    });
  } catch {
    // 子1件のパース失敗でチェック全体を止めない (feed.ts 旧 processSitemapIndexChildren と同じ
    // best-effort 方針。processFeedContent の AdapterParseError rethrow とは意図的に異なる)。
    await setTargetLastChecked(ctx.db, childTarget.id, checkedAtIso);
    return;
  }
  await setTargetLastChecked(ctx.db, childTarget.id, checkedAtIso);

  // 8. urlset / sitemap-index で展開方法が分岐する。
  if (parsed.kind === 'sitemap') {
    const filtered = filterItemsForTraversal(parsed.items, cutoffIso, counts);
    if (filtered.length > 0) {
      const { truncatedCount } = await processFeedItems(ctx, filtered);
      if (truncatedCount > 0) {
        // MAX_FEED_ITEMS_PER_CHECK 超過分は今回処理されず次回以降のチェックに持ち越される
        // (ADR-0010 §5「超過分は…次回以降のチェックに持ち越す」)。ここで watermark を進めて
        // しまうと、次回チェック時に子のlastmodが (今回観測した値と) 一致してしまい
        // watermarkゲート (5.) でフェッチ自体がスキップされ、持ち越し分が子のlastmodが
        // 次に変わるまで永久に処理されなくなる。そのため展開が「不完全」だったこの回は
        // watermark を進めずに return し、次回また同じ子を再展開させる (先頭側は dedupeKey
        // で no-op になるだけなので実害はなく、残余分だけが新たに処理される)。
        counts.feedItemsTruncated += truncatedCount;
        return;
      }
    }
  } else {
    if (depth + 1 < maxDepth) {
      await traverseSitemapIndex(ctx, parsed, depth + 1, cutoffIso, maxDepth, counts);
    } else {
      // 深さ上限到達: これ以上のネストは展開しない (打ち切りとして記録する)。
      counts.depthTruncated += 1;
      return; // watermark は進めない (展開が完了していないため)
    }
  }

  // 9. 子の展開 (processFeedItems / 再帰) が正常完了した後にのみ watermark を前進する
  // (at-least-once復旧のため。途中でクラッシュした場合、次回再試行時にまだ「未処理」として
  // 再度この分岐に入れるようにする。feed.ts の setTargetLastKnownUpdatedAt コメント参照)。
  if (childLastmod !== null) {
    await setTargetLastKnownUpdatedAt(ctx.db, childTarget.id, childLastmod);
  }
}

/**
 * sitemap-index 1件分の子Sitemap一覧を評価・展開する (再帰可能)。
 * depth はこの sitemap-index 自体のネスト深さ (ルート = 0)。
 */
export async function traverseSitemapIndex(
  ctx: CheckContext,
  parsed: AdapterParseResult,
  depth: number,
  cutoffIso: string,
  maxDepth: number,
  counts: TraversalCounts,
): Promise<void> {
  // sitemap-index の parsed.items は buildSitemapIndexResult (src/adapters/sitemap.ts) が
  // 子Sitemapごとに stableKey=loc=url・updatedAt=lastmod として詰めたものなので、
  // childSitemaps とのインデックス対応を仮定せず items から直接 { loc, lastmod } を導出する。
  const childEntries = parsed.items
    .filter((item): item is typeof item & { url: string } => item.url !== null)
    .map((item) => ({ loc: item.url, lastmod: item.updatedAt }));

  const toProcess = childEntries.slice(0, MAX_CHILD_SITEMAPS);
  if (childEntries.length > MAX_CHILD_SITEMAPS) {
    counts.childrenTruncated += childEntries.length - MAX_CHILD_SITEMAPS;
  }

  for (const { loc, lastmod } of toProcess) {
    await traverseChild(ctx, loc, lastmod, depth, cutoffIso, maxDepth, counts);
  }
}

/**
 * 打ち切り・スキップの件数を console.warn / audit_events へ記録する。
 *
 * 発火条件を2段階に分ける (レビュー指摘対応):
 * - console.warn: 5カウントのいずれか1つでも正なら出す (運用ログとしては originBlocked /
 *   missingLastmodSkipped も見えていてほしいため)。
 * - audit_events (action: 'monitor.traversal_truncated'): 「実際に作業を打ち切った」
 *   (childrenTruncated + depthTruncated + feedItemsTruncated > 0) 場合のみ記録する。
 *   originBlocked (越境の子を毎回除外する) と missingLastmodSkipped (lastmod無しの実URLを
 *   毎回除外する) は、対象のSitemap構成次第では*毎チェック定常的に*発生しうる正常なフィルタ
 *   動作であり、ADR-0010 §5が指す「打ち切り」(本来処理すべきだった対象を上限のせいで諦めた)
 *   とは性質が異なる。これを audit 発火条件に含めると、そのようなSourceでは毎チェック
 *   audit_events に1行ずつ積み上がり続けてしまう (スパム化・監査ログとしての意味が薄れる)。
 */
async function recordTruncationIfAny(
  ctx: CheckContext,
  counts: TraversalCounts,
  limits: { lastmodMaxAgeDays: number; maxDepth: number },
): Promise<void> {
  const { childrenTruncated, depthTruncated, originBlocked, missingLastmodSkipped, feedItemsTruncated } = counts;
  const anyCount =
    childrenTruncated > 0 || depthTruncated > 0 || originBlocked > 0 || missingLastmodSkipped > 0 || feedItemsTruncated > 0;
  if (!anyCount) return;

  const payload = {
    childrenTruncated,
    depthTruncated,
    originBlocked,
    missingLastmodSkipped,
    feedItemsTruncated,
    maxChildSitemaps: MAX_CHILD_SITEMAPS,
    maxDepth: limits.maxDepth,
    lastmodMaxAgeDays: limits.lastmodMaxAgeDays,
  };
  console.warn(
    `[sitemapTraversal] monitor=${ctx.monitor.id} truncated during traversal: ${JSON.stringify(payload)}`,
  );

  const didTruncateWork = childrenTruncated > 0 || depthTruncated > 0 || feedItemsTruncated > 0;
  if (!didTruncateWork) return;

  await recordAuditEvent(ctx.db, {
    actor: 'system',
    action: 'monitor.traversal_truncated',
    subject: ctx.monitor.id,
    payload,
  });
}

/**
 * sitemap / sitemap-index Source の Source URL 本体取得後の処理 (Sitemap 探索, ADR-0010 Phase B)。
 * processFeedContent と同じ形状のエントリポイント (ctx, target, checkAttemptId, outcome, body)。
 */
export async function processSitemapTraversal(
  ctx: CheckContext,
  target: TargetRow,
  checkAttemptId: string | null,
  outcome: FetchSuccess,
  body: Uint8Array,
): Promise<void> {
  const rawHash = await sha256Hex(body);
  await putIfAbsent(ctx.env.BODIES, bodyKey(rawHash), body);

  // processFeedContent と同じ方針: パース不能な本文は Snapshot を作らずスキップする
  // (attempt は既に success で記録済み)。AdapterParseError 以外は re-throw する。
  let parsed: AdapterParseResult;
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

  const lastmodMaxAgeDays = ctx.source.config?.lastmodMaxAgeDays ?? DEFAULT_LASTMOD_MAX_AGE_DAYS;
  const maxDepth = ctx.source.config?.maxDepth ?? DEFAULT_MAX_TRAVERSAL_DEPTH;
  const cutoffIso = new Date(ctx.now() - lastmodMaxAgeDays * 86_400_000).toISOString();
  const counts = newCounts();

  if (parsed.kind === 'sitemap') {
    // Source自体が urlset の場合: cutoffフィルタ後、実URLの new/updated 検知を processFeedItems に委譲する。
    // (root自体には「次回に持ち越す watermark」という概念がない — Source本体は毎回そのまま
    // 再取得・再パースされるため、feedItemsTruncated は打ち切り件数の記録のみに使う。)
    const filtered = filterItemsForTraversal(parsed.items, cutoffIso, counts);
    if (filtered.length > 0) {
      const { truncatedCount } = await processFeedItems(ctx, filtered);
      counts.feedItemsTruncated += truncatedCount;
    }
  } else {
    await traverseSitemapIndex(ctx, parsed, 0, cutoffIso, maxDepth, counts);
  }

  await recordTruncationIfAny(ctx, counts, { lastmodMaxAgeDays, maxDepth });
}
