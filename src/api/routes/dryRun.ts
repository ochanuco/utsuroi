/**
 * POST /api/dry-run : URL を1本試し撃ちして robots.txt 判定と `<title>` を返す (ADR-0018)。
 *
 * Site/Source/Monitor に紐づかない単発の下見用エンドポイント。DB へは一切書き込まない
 * (robots キャッシュも robots_evaluations も check_attempts も snapshot も作らない)。
 *
 * 手順は enrichTitle.ts の fetchTitleForUrl と同じ並び (SSRF静的/動的検査 → checkRobots →
 * フェッチ → デコード → title抽出) だが、2点だけ意図的に異なる:
 *  - robots が disallow でもフェッチを続行し、判定は結果に載せて返すだけ (ADR-0018)。
 *  - robots キャッシュを渡さない。毎回 robots.txt を実際に取りに行き、いま現在の状態を返す。
 * SSRF 検査だけはセキュリティ境界なので従来どおり強制する (拒否時は 400)。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { httpFetch } from '../../fetch';
import { checkUrlForSsrf, resolveAndCheck } from '../../net';
import { checkRobots } from '../../robots';
import { extractCharsetFromContentType } from '../../normalize';
import { decodeHtmlBestEffort } from '../../normalize/charset';
import { extractHtmlTitle } from '../../normalize/extractTitle';
import type { DnsResolver } from '../../net';
import type { Env } from '../../shared/env';
import { badRequest } from '../errors';
import { parseWith, readJsonBody } from '../http';

const dryRunSchema = z.object({
  url: z.string().url(),
});

/** レスポンスが HTML と判定できる content-type か (enrichTitle.ts と同じ判定) */
function isHtmlContentType(contentType: string | null): boolean {
  return contentType !== null && contentType.toLowerCase().includes('text/html');
}

export function dryRunRoutes(opts: { ssrfResolver?: DnsResolver; fetchImpl?: typeof fetch } = {}) {
  const router = new Hono<{ Bindings: Env }>();

  router.post('/', async (c) => {
    const body = parseWith(dryRunSchema, await readJsonBody(c));

    // zod の .url() は http/https 以外 (javascript:, file: 等) も通すので、ここで絞る
    const parsed = URL.parse(body.url);
    if (!parsed) throw badRequest('invalid_url', 'url could not be parsed');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw badRequest('unsupported_scheme', `unsupported url scheme: ${parsed.protocol}`);
    }
    const origin = parsed.origin;

    // SSRF はポリシーではなく境界なので DryRun でも強制する
    const staticCheck = checkUrlForSsrf(body.url);
    if (!staticCheck.allowed) {
      throw badRequest('ssrf_blocked', `url rejected by SSRF check: ${staticCheck.reason}`);
    }
    const resolvedCheck = await resolveAndCheck(body.url, {
      resolver: opts.ssrfResolver,
      fetchImpl: opts.fetchImpl,
    });
    if (!resolvedCheck.allowed) {
      throw badRequest('ssrf_blocked', `url rejected by SSRF check: ${resolvedCheck.reason}`);
    }

    // cache を渡さないので毎回実取得。判定結果は返すだけで、ここで実行を止めはしない
    const decision = await checkRobots(origin, body.url, {
      fetchImpl: opts.fetchImpl,
      userAgent: c.env.USER_AGENT,
    });

    const outcome = await httpFetch(
      { url: body.url, userAgent: c.env.USER_AGENT },
      { fetch: opts.fetchImpl, urlGuard: checkUrlForSsrf },
    );

    let title: string | null = null;
    let titleSkipReason: string | null = null;

    if (!outcome.ok) {
      titleSkipReason = `fetch failed (${outcome.failureClass}): ${outcome.message}`;
    } else if (outcome.status !== 200 || !outcome.body) {
      titleSkipReason = `non-200 or empty body (status ${outcome.status})`;
    } else if (!isHtmlContentType(outcome.contentType)) {
      titleSkipReason = `non-html content-type (${outcome.contentType ?? 'null'})`;
    } else {
      const html = decodeHtmlBestEffort(outcome.body, extractCharsetFromContentType(outcome.contentType));
      title = await extractHtmlTitle(html);
      if (title === null) titleSkipReason = 'no title found';
    }

    return c.json({
      url: body.url,
      origin,
      robots: {
        robots_url: decision.robotsUrl,
        // unavailable = robots.txt 自体を取得できなかった (5xx/network error)。
        // 4xx は RFC 9309 上「全許可」なので reachable=true / verdict=allowed になる。
        reachable: !decision.unavailable,
        verdict: decision.verdict,
        user_agent_group: decision.userAgentGroup,
        matched_rule: decision.matchedRule,
        checked_at: decision.fetchedAt,
      },
      fetch: outcome.ok
        ? {
            ok: true,
            status: outcome.status,
            final_url: outcome.finalUrl,
            content_type: outcome.contentType,
            duration_ms: outcome.durationMs,
            failure_class: null,
            error_message: null,
          }
        : {
            ok: false,
            status: outcome.status,
            final_url: null,
            content_type: null,
            duration_ms: null,
            failure_class: outcome.failureClass,
            error_message: outcome.message,
          },
      title,
      title_skip_reason: titleSkipReason,
    });
  });

  return router;
}
