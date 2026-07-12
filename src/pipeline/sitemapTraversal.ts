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
 * - lastmod足切り (既定 DEFAULT_LASTMOD_MAX_AGE_DAYS 日): 対象外の実URL/子Sitemapは展開しない
 *   (子Sitemapの足切りは traverseSitemapIndex 側で MAX_CHILD_SITEMAPS の枠取りより前に行う)。
 * - 子Sitemap数上限 (MAX_CHILD_SITEMAPS, feed.ts の既定値を再利用): 超過分は打ち切る。
 *   cutoff適用後のエントリを lastmod 降順 (未知/nullは最後) にソートしてから枠を割り当てるため、
 *   「安定して21件以上の子が並ぶ」サイトでも実際に変化した子が優先的に処理される
 *   (CodeRabbit指摘: 文書順の先頭固定だと21件目以降が恒久除外されてしまう問題への対応)。
 * - 再帰深さ上限 (既定 DEFAULT_MAX_TRAVERSAL_DEPTH): 到達したら以降のネストは展開しない。
 * - origin境界: 親Siteのcanonical origin外の子Sitemapは展開しない。
 * - 実URL処理上限 (MAX_FEED_ITEMS_PER_CHECK, processFeedItems 側): 超過分は次回以降の
 *   チェックに持ち越す (この場合、超過を起こした子の watermark は進めない。下記コメント参照)。
 * - フェッチ予算上限 (MAX_TRAVERSAL_FETCHES_PER_CHECK, ADR-0010 §5 最終防波堤): 深さ上限・
 *   子数上限は「1階層あたり」の上限に過ぎず、再帰全体で見ると最悪ケース (子数上限 × 深さ段数) の
 *   HTTP subrequestバーストになりうる。チェック全体で共有する子Sitemapフェッチ回数の総量に
 *   上限を設け、超過分はフェッチせず次回以降に持ち越す。
 *
 * これらのうち実際に「作業を打ち切った」もの (childrenTruncated / depthTruncated /
 * feedItemsTruncated / fetchBudgetTruncated) はチェック終了時に console.warn + audit_events
 * (action: 'monitor.traversal_truncated') へまとめて1件記録する (無言で落とさない)。
 * originBlocked / missingLastmodSkipped は境界外/足切り対象の通常スキップであり定常的に
 * 発生しうるため、console.warn のみ (audit行の記録条件は recordTruncationIfAny 参照)。
 *
 * lastmod (updatedAt) が無いエントリは、実URL・子Sitemapとも traverse モードでは常にスキップ
 * する (実URLは足切りの基準にできず、子SitemapはwatermarkゲートできずADR-0010「lastmodが変化
 * した子だけを展開する」契約を破って毎チェック無条件フェッチになるため。モードBはlastmodを
 * 信頼できるサイト向けという前提そのもの。lastmodの無いサイトには Direct モードを使う)。
 *
 * ネストした子sitemap-index (中間ノード) の watermark 前進についても、自分自身の展開だけでなく
 * 再帰先 (孫以下) で何らかの打ち切りが発生していないかを見てから判断する
 * (traverseChild 内の「再帰後の打ち切り総数チェック」コメント参照)。
 *
 * child_include_patterns (ADR-0015, docs/adr/0015-sitemap-child-include-patterns.md):
 * sitemap/sitemap-index Source の config.childIncludePatterns が非空のとき、子Sitemap選択
 * (selectChildEntries) の段でパターンにマッチしない子を除外する。除外はcutoff/lastmod判定と
 * 同じ「選択」段で行われるため、MAX_CHILD_SITEMAPS の枠 (toProcess への slice) は消費しない
 * (Target登録もフェッチも行わない)。selectChildEntries は traverseSitemapIndex の再帰呼び出し
 * (traverseChild 8.) でも常に同じ ctx.source.config を参照するため、ネストした子sitemap-index
 * (中間ノード) にも同じ判定が自動的に効く (種別ごとの分岐を別途持たない)。
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
/**
 * 1回のチェックあたりで子Sitemapを実際にフェッチしてよい回数の上限 (ADR-0010 §5 最終防波堤)。
 * MAX_CHILD_SITEMAPS (1階層あたり) と DEFAULT_MAX_TRAVERSAL_DEPTH (深さ) はそれぞれ独立した
 * 上限であり、組み合わせると再帰全体で最悪 20^depth 規模のフェッチが起こりうる。この定数は
 * チェック全体を通じて共有する「実フェッチ回数」の総量に上限をかけ、超過分は今回フェッチせず
 * 次回以降のチェックに持ち越す (watermark を進めない、traverseChild 内コメント参照)。
 */
export const MAX_TRAVERSAL_FETCHES_PER_CHECK = 50;

/**
 * チェック全体で共有する打ち切り件数 + 状態 (ADR-0010 §5「打ち切りは無言にせず記録する」)。
 * fetchesUsed は「打ち切り件数」ではなく、フェッチ予算の消費量を再帰全体で共有するための状態。
 */
interface TraversalCounts {
  /** MAX_CHILD_SITEMAPS 超過で展開しなかった子Sitemap数 (cutoff適用後の件数で判定、合算) */
  childrenTruncated: number;
  /** 再帰深さ上限に達し展開しなかった子 sitemap-index 数 */
  depthTruncated: number;
  /** 親Siteのcanonical origin外だったため展開しなかった子Sitemap数 */
  originBlocked: number;
  /** updatedAt (lastmod) が無く足切り不能・ゲート不能だったため無視した実URL・子Sitemap数 */
  missingLastmodSkipped: number;
  /** processFeedItems 側 (MAX_FEED_ITEMS_PER_CHECK) で打ち切られ、次回以降に持ち越された実URL数 */
  feedItemsTruncated: number;
  /** MAX_TRAVERSAL_FETCHES_PER_CHECK 超過で今回フェッチしなかった子Sitemap数 (次回持ち越し) */
  fetchBudgetTruncated: number;
  /** チェック全体で実行した子Sitemapフェッチ回数 (フェッチ予算の消費量) */
  fetchesUsed: number;
  /**
   * child_include_patterns (ADR-0015) にマッチせず選択段で除外した子Sitemap数。
   * originBlocked / missingLastmodSkipped と同様、利用者が意図的に設定した定常フィルタであり
   * 「打ち切り」ではないため truncationTotal() には含めない (下記 truncationTotal 参照)。
   */
  patternExcluded: number;
}

function newCounts(): TraversalCounts {
  return {
    childrenTruncated: 0,
    depthTruncated: 0,
    originBlocked: 0,
    missingLastmodSkipped: 0,
    feedItemsTruncated: 0,
    fetchBudgetTruncated: 0,
    fetchesUsed: 0,
    patternExcluded: 0,
  };
}

/** 「実際の作業打ち切り」の合計 (originBlocked/missingLastmodSkippedは通常のフィルタなので含めない) */
function truncationTotal(counts: TraversalCounts): number {
  return counts.childrenTruncated + counts.depthTruncated + counts.feedItemsTruncated + counts.fetchBudgetTruncated;
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

interface ChildEntry {
  loc: string;
  lastmod: string | null;
}

/** selectChildEntries を通過した (=lastmod を必ず持つ) 子Sitemapエントリ */
interface SelectedChildEntry {
  loc: string;
  lastmod: string;
}

/**
 * '*' (0文字以上の任意文字) のみをワイルドカードとして扱う glob パターンを、ファイル名全体に
 * アンカーした正規表現へ変換する (ADR-0015)。'*' 以外の文字は正規表現メタ文字も含めすべて
 * リテラル扱いにする (例: 'post-sitemap.xml' の '.' が任意の1文字にマッチしてしまうと
 * 'post-sitemapXxml' のような無関係なファイル名まで拾ってしまうため)。
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * 子Sitemap URL のパス最終セグメント (ファイル名) が、いずれかの child_include_patterns に
 * マッチするかどうかを判定する (ADR-0015)。大文字小文字は区別する。
 * URL 自体が不正でパースできない場合は安全側 (マッチしない = traverse対象外) に倒す。
 * export しているのは単体テスト (test/pipeline/sitemapTraversal.test.ts) から直接検証するため。
 */
export function matchesChildIncludePattern(childUrl: string, patterns: string[]): boolean {
  let filename: string;
  try {
    const pathname = new URL(childUrl).pathname;
    filename = pathname.slice(pathname.lastIndexOf('/') + 1);
  } catch {
    return false;
  }
  return patterns.some((pattern) => globToRegExp(pattern).test(filename));
}

/**
 * sitemap-index 配下の子Sitemapエントリを cutoff でフィルタし、lastmod 降順にソートする。
 * - lastmod の無い子は除外する (実URL側と同様に missingLastmodSkipped へ数える)。lastmod が
 *   無いと watermarkゲート (traverseChild 4.) が成立せず、baseline 後も毎チェック無条件で
 *   フェッチ・展開されてしまい、「lastmodが変化した子だけを展開する」という ADR-0010 モードBの
 *   契約を破って子数枠とフェッチ予算を消費し続けるため (レビュー指摘)。そうしたサイトには
 *   Direct モード (lastmod非依存) を使う。
 * - cutoff外の古い子も除外する。どちらも「打ち切り」ではなく通常のフィルタ (originBlocked と
 *   同種の定常スキップ) なので audit には数えない (スパム防止の一貫性)。
 * - childIncludePatterns (ADR-0015) が非空なら、いずれのパターンにもマッチしない子をここで
 *   除外する (patternExcluded へ計上)。MAX_CHILD_SITEMAPS の枠割り当て (呼び出し元の slice) より
 *   前段で除外するため、マッチしない子は探索枠を一切消費しない。
 * ソートにより、MAX_CHILD_SITEMAPS の枠を「文書順の先頭」ではなく「実際に最近変化した子」が
 * 優先的に得られるようにする (安定して21件以上の子が並ぶサイトでの恒久除外を防ぐ)。
 * Array#sort は安定ソートなので、lastmod が同値の場合は文書順を維持する。
 */
function selectChildEntries(
  entries: ChildEntry[],
  cutoffIso: string,
  counts: TraversalCounts,
  childIncludePatterns: string[] | undefined,
): SelectedChildEntry[] {
  const eligible: SelectedChildEntry[] = [];
  for (const e of entries) {
    if (e.lastmod === null) {
      counts.missingLastmodSkipped += 1;
      continue;
    }
    if (e.lastmod < cutoffIso) continue;
    if (childIncludePatterns && childIncludePatterns.length > 0 && !matchesChildIncludePattern(e.loc, childIncludePatterns)) {
      counts.patternExcluded += 1;
      continue;
    }
    eligible.push({ loc: e.loc, lastmod: e.lastmod });
  }
  return eligible.sort((a, b) => (a.lastmod < b.lastmod ? 1 : a.lastmod > b.lastmod ? -1 : 0)); // 降順 (新しい方を優先)
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
 * 呼び出し順序 (ADR-0010 §5, §3 に対応。lastmod cutoff は呼び出し元 traverseSitemapIndex 側で
 * 既に適用済みなのでここでは判定しない):
 * 1. origin境界 → 2. Target upsert (watermark取得は upsert 前) → 3. baseline (フェッチ・展開しない) →
 * 4. watermark比較でのゲート → 5. SSRF/robots (HostObject 追加leaseは取らない、feed.ts の
 * 既存設計判断を踏襲) → 6. フェッチ予算チェック (MAX_TRAVERSAL_FETCHES_PER_CHECK) →
 * 7. 条件付きフェッチ → 8. urlset なら processFeedItems、sitemap-index なら再帰 →
 * 9. 展開が正常完了した後にのみ watermark を前進 (at-least-once 復旧のため、feed.ts と同じ理由。
 * 加えて再帰先で打ち切りが起きていないことも条件にする、9.の直前コメント参照)。
 */
async function traverseChild(
  ctx: CheckContext,
  childUrl: string,
  // selectChildEntries が lastmod の無い子を除外済みのため常に非null (watermarkゲートの前提)
  childLastmod: string,
  depth: number,
  cutoffIso: string,
  maxDepth: number,
  counts: TraversalCounts,
  maxFetchesPerCheck: number,
): Promise<void> {
  // 1. origin境界 (ADR-0010 §5「親Siteのcanonical origin内に限定する」)。
  if (!isWithinSiteOrigin(childUrl, ctx.site.primaryOrigin)) {
    counts.originBlocked += 1;
    return;
  }

  // 2. watermark はこの Target を upsert する前の値を見る (isNew 判定・ゲート判定の両方に使う)。
  const previous = await getExistingTargetWatermark(ctx.db, ctx.monitor.id, childUrl);
  const isNewChild = !previous.exists;
  const childTarget = await upsertTarget(ctx.db, {
    monitorId: ctx.monitor.id,
    url: childUrl,
    discoveredFrom: 'sitemap-index',
    // 新規Targetのみ子のlastmodを初期watermarkとして記録する (feed.ts processFeedItems と同じ規約)。
    lastKnownUpdatedAt: isNewChild ? childLastmod : undefined,
  });

  // 3. baseline: 子Targetの登録とwatermark初期化のみ行い、フェッチも展開もしない
  // (ADR-0010 §3「初回に子Sitemapのlastmodを記録し、実URLを一括展開しない」)。
  if (ctx.monitor.lastCheckedAt === null) {
    await setTargetLastChecked(ctx.db, childTarget.id, new Date(ctx.now()).toISOString());
    return;
  }

  // 4. watermarkゲート: 既存Targetで、子のlastmodが既存watermark以下 (同一または後退) なら
  // フェッチせずスキップする。単純な不一致判定 (!==) だと、lastmodが一時的に後退するサイト
  // (キャッシュ揺れ等) で watermark が単調増加せず、値の揺れのたびに再展開+watermark巻き戻しを
  // 繰り返してしまう (CodeRabbit指摘)。<= 判定により watermark は前進方向にしか動かない。
  // (新規に見つかった子と、既存だがwatermark未記録 (null) の子はゲートできないため、常に
  // この先へ進み条件付きフェッチする。lastmodの無い子は selectChildEntries で除外済み)。
  if (!isNewChild && previous.lastKnownUpdatedAt !== null && childLastmod <= previous.lastKnownUpdatedAt) {
    await setTargetLastChecked(ctx.db, childTarget.id, new Date(ctx.now()).toISOString());
    return;
  }

  // 5. SSRF (静的+動的) / robots 評価 (feed.ts の旧 processSitemapIndexChildren と同じ判断:
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

  // 6. フェッチ予算 (MAX_TRAVERSAL_FETCHES_PER_CHECK, ADR-0010 §5 最終防波堤)。
  // 予算を使い切っている場合はフェッチせずスキップする (watermark も進めない = 次回持ち越し。
  // feedItemsTruncated と同じ理由: ここで watermark を進めてしまうと、次回チェック時に
  // 子のlastmodが今回観測した値と一致してゲートされ、持ち越し分がlastmodが次に変わるまで
  // 永久に処理されなくなる)。
  if (counts.fetchesUsed >= maxFetchesPerCheck) {
    counts.fetchBudgetTruncated += 1;
    return;
  }
  counts.fetchesUsed += 1;

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
        // watermarkゲート (4.) でフェッチ自体がスキップされ、持ち越し分が子のlastmodが
        // 次に変わるまで永久に処理されなくなる。そのため展開が「不完全」だったこの回は
        // watermark を進めずに return し、次回また同じ子を再展開させる (先頭側は dedupeKey
        // で no-op になるだけなので実害はなく、残余分だけが新たに処理される)。
        counts.feedItemsTruncated += truncatedCount;
        return;
      }
    }
  } else {
    // 再帰 (孫以下) に入る前の打ち切り総数をスナップショットしておく。再帰から戻った後に
    // 総数が増えていれば、孫以下のどこかで (子数上限 / 深さ上限 / 実URL処理上限 / フェッチ予算の
    // いずれであれ) 展開が「不完全」に終わったということなので、この中間ノード (子sitemap-index)
    // 自身の watermark も前進させない。これを怠ると、孫で打ち切りが起きた回だけこの中間ノードの
    // watermark が先に進んでしまい、次回チェックで watermarkゲート (4.) に阻まれて中間ノードの
    // 再フェッチ自体が起こらなくなり、孫の持ち越し分がこの中間ノードのlastmodが次に変わるまで
    // 恒久的に再展開されなくなる (feedItemsTruncatedで修正したのと同じ故障モードが、再帰の
    // 1つ上の階層でも起こりうる。CodeRabbitの提案は childrenTruncated + depthTruncated のみ
    // だったが、feedItemsTruncated / fetchBudgetTruncated も同じ理由で中間ノードを恒久ゲート
    // させうるため、4種類すべての打ち切りカウンタの合計で判定する)。
    if (depth + 1 < maxDepth) {
      const truncatedBefore = truncationTotal(counts);
      await traverseSitemapIndex(ctx, parsed, depth + 1, cutoffIso, maxDepth, counts, maxFetchesPerCheck);
      if (truncationTotal(counts) > truncatedBefore) return;
    } else {
      // 深さ上限到達: これ以上のネストは展開しない (打ち切りとして記録する)。
      counts.depthTruncated += 1;
      return; // watermark は進めない (展開が完了していないため)
    }
  }

  // 9. 子の展開 (processFeedItems / 再帰) が正常完了した後にのみ watermark を前進する
  // (at-least-once復旧のため。途中でクラッシュした場合、次回再試行時にまだ「未処理」として
  // 再度この分岐に入れるようにする。feed.ts の setTargetLastKnownUpdatedAt コメント参照)。
  // ゲート (4.) の <= 判定により、ここへ到達する既存Targetの childLastmod は必ず既存watermark
  // より新しいため、この保存で watermark が後退することはない (単調増加)。
  await setTargetLastKnownUpdatedAt(ctx.db, childTarget.id, childLastmod);
}

/**
 * sitemap-index 1件分の子Sitemap一覧を評価・展開する (再帰可能)。
 * depth はこの sitemap-index 自体のネスト深さ (ルート = 0)。
 * maxFetchesPerCheck はテスト用の注入ポイント (processFeedItems の maxItems と同じパターン)。
 * 省略時は既定の MAX_TRAVERSAL_FETCHES_PER_CHECK を使う。
 */
export async function traverseSitemapIndex(
  ctx: CheckContext,
  parsed: AdapterParseResult,
  depth: number,
  cutoffIso: string,
  maxDepth: number,
  counts: TraversalCounts,
  maxFetchesPerCheck: number = MAX_TRAVERSAL_FETCHES_PER_CHECK,
): Promise<void> {
  // sitemap-index の parsed.items は buildSitemapIndexResult (src/adapters/sitemap.ts) が
  // 子Sitemapごとに stableKey=loc=url・updatedAt=lastmod として詰めたものなので、
  // childSitemaps とのインデックス対応を仮定せず items から直接 { loc, lastmod } を導出する。
  const childEntries: ChildEntry[] = parsed.items
    .filter((item): item is typeof item & { url: string } => item.url !== null)
    .map((item) => ({ loc: item.url, lastmod: item.updatedAt }));

  // cutoff適用 (古い子・lastmod無しの子は通常のフィルタとして除外) + child_include_patterns
  // (ADR-0015、非マッチ子も同段で除外) + lastmod降順ソート後に MAX_CHILD_SITEMAPS の枠を
  // 割り当てる。childrenTruncated は「フィルタ後」の超過分だけ数える (cutoff外・非マッチの子を
  // 除外したこと自体は打ち切りではないため、audit スパム防止の一貫性)。
  const selected = selectChildEntries(childEntries, cutoffIso, counts, ctx.source.config?.childIncludePatterns);
  const toProcess = selected.slice(0, MAX_CHILD_SITEMAPS);
  if (selected.length > MAX_CHILD_SITEMAPS) {
    counts.childrenTruncated += selected.length - MAX_CHILD_SITEMAPS;
  }

  for (const { loc, lastmod } of toProcess) {
    await traverseChild(ctx, loc, lastmod, depth, cutoffIso, maxDepth, counts, maxFetchesPerCheck);
  }
}

/**
 * 打ち切り・スキップの件数を console.warn / audit_events へ記録する。
 *
 * 発火条件を2段階に分ける (レビュー指摘対応):
 * - console.warn: 6カウントのいずれか1つでも正なら出す (運用ログとしては originBlocked /
 *   missingLastmodSkipped も見えていてほしいため)。
 * - audit_events (action: 'monitor.traversal_truncated'): 「実際に作業を打ち切った」
 *   (childrenTruncated + depthTruncated + feedItemsTruncated + fetchBudgetTruncated > 0,
 *   truncationTotal() 参照) 場合のみ記録する。originBlocked (越境の子を毎回除外する) と
 *   missingLastmodSkipped (lastmod無しの実URLを毎回除外する)、patternExcluded
 *   (child_include_patterns にマッチしない子を毎回除外する、ADR-0015) は、対象のSitemap構成
 *   次第では*毎チェック定常的に*発生しうる正常なフィルタ動作であり、ADR-0010 §5が指す「打ち切り」
 *   (本来処理すべきだった対象を上限のせいで諦めた) とは性質が異なる。これを audit 発火条件に
 *   含めると、そのようなSourceでは毎チェック audit_events に1行ずつ積み上がり続けてしまう
 *   (スパム化・監査ログとしての意味が薄れる)。
 */
async function recordTruncationIfAny(
  ctx: CheckContext,
  counts: TraversalCounts,
  limits: { lastmodMaxAgeDays: number; maxDepth: number; maxFetchesPerCheck: number },
): Promise<void> {
  const {
    childrenTruncated,
    depthTruncated,
    originBlocked,
    missingLastmodSkipped,
    feedItemsTruncated,
    fetchBudgetTruncated,
    patternExcluded,
  } = counts;
  const anyCount =
    childrenTruncated > 0 ||
    depthTruncated > 0 ||
    originBlocked > 0 ||
    missingLastmodSkipped > 0 ||
    feedItemsTruncated > 0 ||
    fetchBudgetTruncated > 0 ||
    patternExcluded > 0;
  if (!anyCount) return;

  const payload = {
    childrenTruncated,
    depthTruncated,
    originBlocked,
    missingLastmodSkipped,
    feedItemsTruncated,
    fetchBudgetTruncated,
    patternExcluded,
    maxChildSitemaps: MAX_CHILD_SITEMAPS,
    maxDepth: limits.maxDepth,
    lastmodMaxAgeDays: limits.lastmodMaxAgeDays,
    maxTraversalFetchesPerCheck: limits.maxFetchesPerCheck,
  };
  console.warn(
    `[sitemapTraversal] monitor=${ctx.monitor.id} truncated during traversal: ${JSON.stringify(payload)}`,
  );

  if (truncationTotal(counts) === 0) return;

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
 * maxFetchesPerCheck はテスト用の注入ポイント (省略時は既定の MAX_TRAVERSAL_FETCHES_PER_CHECK)。
 */
export async function processSitemapTraversal(
  ctx: CheckContext,
  target: TargetRow,
  checkAttemptId: string | null,
  outcome: FetchSuccess,
  body: Uint8Array,
  maxFetchesPerCheck: number = MAX_TRAVERSAL_FETCHES_PER_CHECK,
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
    await traverseSitemapIndex(ctx, parsed, 0, cutoffIso, maxDepth, counts, maxFetchesPerCheck);
  }

  await recordTruncationIfAny(ctx, counts, { lastmodMaxAgeDays, maxDepth, maxFetchesPerCheck });
}
