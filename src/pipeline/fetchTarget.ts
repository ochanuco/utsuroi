/**
 * Fetcher Policy (OrderList) に従って1つの URL を取得し、試行ごとに check_attempts を記録する。
 * Page の Source URL、Feed/Sitemap の Source URL、Sitemap Index の子 Sitemap URL のいずれからも使う。
 */
import { defaultFetcherRegistry, runFetcher, runFetchSequence } from '../fetch';
import { createCheckAttempt } from '../db';
import { checkUrlForSsrf } from '../net';
import { failure } from '../fetch/http';
import type { FetchOutcome } from '../shared/contracts';
import type { CheckContext } from './types';

export interface FetchTargetResult {
  outcome: FetchOutcome;
  /** 最後に記録した check_attempt の ID (成功時の Snapshot 紐付けに使う) */
  lastAttemptId: string | null;
}

/**
 * fetcherId は Fetcher レジストリ (src/fetch/registry.ts) で実装へ解決する。未登録の id は internal_error。
 */
export async function fetchTargetThroughPolicy(
  ctx: CheckContext,
  targetId: string,
  url: string,
  conditional: { etag: string | null; lastModified: string | null },
): Promise<FetchTargetResult> {
  let attemptIndex = 0;
  let lastAttemptId: string | null = null;

  const executeFetcher = async (fetcherId: string): Promise<FetchOutcome> => {
    const index = attemptIndex++;

    const unavailable = (ctx.unavailableFetchers ??= new Set<string>());
    const jobRef: { executorJobId?: string } = {};
    const outcome = unavailable.has(fetcherId)
      ? failure('executor_unavailable', null, `${fetcherId}: executor was unavailable earlier in this check`, null)
      : await runFetcher(defaultFetcherRegistry, fetcherId, {
          url,
          userAgent: ctx.env.USER_AGENT,
          etag: conditional.etag,
          lastModified: conditional.lastModified,
          env: ctx.env,
          fetchImpl: ctx.fetchImpl,
          urlGuard: checkUrlForSsrf,
          jobRef,
        });
    if (!outcome.ok && outcome.failureClass === 'executor_unavailable') unavailable.add(fetcherId);

    const attemptId = crypto.randomUUID();
    lastAttemptId = attemptId;
    await createCheckAttempt(ctx.db, {
      id: attemptId,
      checkJobId: ctx.job.id,
      targetId,
      fetcherId,
      attemptIndex: index,
      outcome: outcome.ok ? 'success' : 'failure',
      failureClass: outcome.ok ? null : outcome.failureClass,
      statusCode: outcome.status,
      durationMs: outcome.ok ? outcome.durationMs : null,
      errorMessage: outcome.ok ? null : outcome.message,
      executorJobId: jobRef.executorJobId ?? null,
    });

    return outcome;
  };

  const result = await runFetchSequence(ctx.policy, executeFetcher);
  return { outcome: result.outcome, lastAttemptId };
}
