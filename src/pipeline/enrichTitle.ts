/**
 * Detect段が検出した Change のうち、kind='new' かつ title が無いものに対し、
 * targetUrl を軽量フェッチして `<title>` を取得し Change.title へ書き戻す
 * (ADR-0016 Notify段直前の Enrich段)。
 *
 * 1URLの取得手順は sitemapTraversal.ts の traverseChild と同じ順序 (SSRF静的/動的検査 →
 * checkRobots → fetcher policy 経由フェッチ) を踏襲する。ただし fetchTargetThroughPolicy は
 * check_attempts への記録を前提とした仕組みのため使わず、runFetchSequence + httpFetch を
 * 直接組み合わせる (このフェッチは snapshot / check_attempts / target を一切更新しない、
 * title 取得だけの副作用フリーな軽量フェッチ)。
 *
 * 失敗はすべて非致死: SSRF拒否・robots拒否・フェッチ失敗・非HTML・title無し・抽出例外の
 * いずれも console.warn してスキップするのみで、この関数から例外を漏らさない
 * (通知 (Notify段) を止めないため)。
 */
import { httpFetch, runFetchSequence } from '../fetch';
import { checkUrlForSsrf, resolveAndCheck } from '../net';
import { checkRobots } from '../robots';
import { getRobotsMode, updateChangeTitle } from '../db';
import { extractHtmlTitle } from '../normalize/extractTitle';
import { createD1RobotsCache } from './robotsCache';
import type { DetectedChange } from './notify';
import type { CheckContext } from './types';

/** 1回のチェックあたりでタイトル取得のためにフェッチしてよい回数の上限 (チェック全体で共有) */
export const MAX_TITLE_FETCHES_PER_CHECK = 10;

/** レスポンスが HTML と判定できる content-type か */
function isHtmlContentType(contentType: string | null): boolean {
  return contentType !== null && contentType.toLowerCase().includes('text/html');
}

/**
 * 1件の Change 対象 URL から `<title>` を取得する。失敗時は null を返す
 * (呼び出し元で理由を1行 console.warn する)。
 */
async function fetchTitleForUrl(ctx: CheckContext, url: string): Promise<{ title: string | null; skipReason: string | null }> {
  const staticCheck = checkUrlForSsrf(url);
  if (!staticCheck.allowed) return { title: null, skipReason: `ssrf blocked (${staticCheck.reason ?? 'unknown'})` };

  const dynamicCheck = await resolveAndCheck(url, { fetchImpl: ctx.fetchImpl });
  if (!dynamicCheck.allowed) return { title: null, skipReason: `ssrf blocked (${dynamicCheck.reason ?? 'unknown'})` };

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return { title: null, skipReason: 'invalid url' };
  }

  const robotsMode = await getRobotsMode(ctx.db, ctx.site.id, origin);
  const decision = await checkRobots(origin, url, {
    fetchImpl: ctx.fetchImpl,
    userAgent: ctx.env.USER_AGENT,
    cache: createD1RobotsCache(ctx.db),
    now: ctx.now,
  });
  if (decision.verdict === 'disallowed' && robotsMode === 'enforce') {
    return { title: null, skipReason: 'robots disallowed' };
  }

  const result = await runFetchSequence(ctx.policy, (fetcherId) =>
    fetcherId === 'cf-http'
      ? httpFetch(
          { url, userAgent: ctx.env.USER_AGENT },
          { fetch: ctx.fetchImpl, urlGuard: checkUrlForSsrf },
        )
      : Promise.resolve({
          ok: false as const,
          failureClass: 'internal_error' as const,
          status: null,
          message: `unknown fetcherId: ${fetcherId}`,
          retryAfterSeconds: null,
        }),
  );
  const outcome = result.outcome;
  if (!outcome.ok) return { title: null, skipReason: `fetch failed (${outcome.failureClass})` };
  if (outcome.status !== 200 || !outcome.body) return { title: null, skipReason: `non-200 or empty body (status ${outcome.status})` };
  if (!isHtmlContentType(outcome.contentType)) return { title: null, skipReason: `non-html content-type (${outcome.contentType ?? 'null'})` };

  const html = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(outcome.body);
  const title = await extractHtmlTitle(html);
  if (title === null) return { title: null, skipReason: 'no title found' };
  return { title, skipReason: null };
}

/**
 * detected のうち inserted && kind='new' && title===null && targetUrl あり の Change だけを
 * 対象に title enrich を行う。予算 (MAX_TITLE_FETCHES_PER_CHECK) は ctx.titleFetchesUsed で
 * チェック全体を通じて共有する。超過分はフェッチせずスキップし console.warn を1回だけ出す。
 */
export async function enrichDetectedChanges(ctx: CheckContext, detected: DetectedChange[]): Promise<void> {
  const targets = detected.filter(
    (d) => d.inserted && d.row.kind === 'new' && d.row.title === null && !!d.row.targetUrl,
  );
  if (targets.length === 0) return;

  let used = ctx.titleFetchesUsed ?? 0;
  let budgetWarned = false;

  for (const d of targets) {
    if (used >= MAX_TITLE_FETCHES_PER_CHECK) {
      if (!budgetWarned) {
        console.warn(
          `[enrichTitle] monitor=${ctx.monitor.id} title fetch budget (${MAX_TITLE_FETCHES_PER_CHECK}) exceeded; skipping remaining candidates`,
        );
        budgetWarned = true;
      }
      continue;
    }
    used += 1;

    try {
      const { title, skipReason } = await fetchTitleForUrl(ctx, d.row.targetUrl);
      if (title !== null) {
        await updateChangeTitle(ctx.db, d.row.id, title);
        d.row.title = title;
      } else if (skipReason) {
        console.warn(`[enrichTitle] monitor=${ctx.monitor.id} change=${d.row.id} skipped: ${skipReason}`);
      }
    } catch (err) {
      console.warn(
        `[enrichTitle] monitor=${ctx.monitor.id} change=${d.row.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  ctx.titleFetchesUsed = used;
}
