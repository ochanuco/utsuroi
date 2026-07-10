/**
 * MonitorObject の Alarm から呼ばれる、1回分の Check 実行本体 (SPEC §10, §17)。
 *
 * フロー: monitor/source/site/policy ロード → 冪等 Job 起動 → SSRF → robots.txt →
 * HostObject lease → Fetcher Policy 順の fetch → Source 種別ごとの内容処理 → 通知ファンアウト →
 * Job 確定・次回スケジュール決定。詳細な設計判断は各ステップのコメントを参照。
 */
import { checkUrlForSsrf, resolveAndCheck } from '../net';
import { checkRobots } from '../robots';
import type { FetchSuccess, HostLimiter } from '../shared/contracts';
import type { Env } from '../shared/env';
import {
  createCheckAttempt,
  createCheckJobIfNew,
  createRobotsEvaluation,
  getFetcherPolicy,
  getLatestSnapshotForTarget,
  getMonitor,
  getRobotsMode,
  getSite,
  getSource,
  policyStopMonitor,
  setMonitorLastChecked,
  setMonitorNextRun,
  setTargetLastChecked,
  updateCheckJobStatus,
  upsertTarget,
} from '../db';
import { createD1RobotsCache } from './robotsCache';
import { fetchTargetThroughPolicy } from './fetchTarget';
import { processPageContent } from './pageContent';
import { processFeedContent } from './feed';
import { hostLimiterFactory } from '../do/hostObject';
import type { CheckContext, CheckRunResult, RunMonitorCheckOptions } from './types';

export type { CheckRunResult, RunMonitorCheckOptions } from './types';

/** ジッターの上限。interval の 10% または 60秒のいずれか小さい方 (設計判断: report 参照) */
function jitterMs(intervalSeconds: number): number {
  const capSeconds = Math.min(intervalSeconds * 0.1, 60);
  if (capSeconds <= 0) return 0;
  return Math.floor(Math.random() * capSeconds * 1000);
}

async function finishJob(ctx: CheckContext, status: 'succeeded' | 'failed'): Promise<CheckRunResult> {
  const nowMs = ctx.now();
  const nowIso = new Date(nowMs).toISOString();
  await updateCheckJobStatus(ctx.db, ctx.job.id, status, { finishedAt: nowIso });
  await setMonitorLastChecked(ctx.db, ctx.monitor.id, nowIso);
  const nextRunAt = new Date(
    nowMs + ctx.monitor.intervalSeconds * 1000 + jitterMs(ctx.monitor.intervalSeconds),
  ).toISOString();
  await setMonitorNextRun(ctx.db, ctx.monitor.id, nextRunAt);
  return { kind: 'completed', nextRunAt, changeIds: ctx.changeIds };
}

export async function runMonitorCheck(
  env: Env,
  monitorId: string,
  opts: RunMonitorCheckOptions = {},
): Promise<CheckRunResult> {
  const db = env.DB;
  const trigger = opts.trigger ?? 'scheduled';
  const nowFn = (): number => (opts.now ? opts.now().getTime() : Date.now());
  const nowIso = (): string => new Date(nowFn()).toISOString();

  // 1. monitor + source + site + fetcher policy
  const monitor = await getMonitor(db, monitorId);
  if (!monitor) {
    throw new Error(`runMonitorCheck: monitor not found: ${monitorId}`);
  }

  // 設計判断: 'archived' と 'blocked_by_robots' は常にスキップ (resume()での明示解除が必要)。
  // 'paused' は scheduled/reconciliation 起動ならスキップするが、manual (MonitorObject.runNow) は
  // 通す (ADR-0003 手動実行サポート、brief「pause中でも手動実行は可」)。'failing' は運用ラベルに過ぎず通す。
  const skipForStatus =
    monitor.status === 'archived' ||
    monitor.status === 'blocked_by_robots' ||
    (monitor.status === 'paused' && trigger !== 'manual');
  if (skipForStatus) {
    return { kind: 'skipped', nextRunAt: monitor.nextRunAt, changeIds: [] };
  }

  const source = await getSource(db, monitor.sourceId);
  if (!source) throw new Error(`runMonitorCheck: source not found: ${monitor.sourceId}`);
  const site = await getSite(db, monitor.siteId);
  if (!site) throw new Error(`runMonitorCheck: site not found: ${monitor.siteId}`);
  const policy = await getFetcherPolicy(db, site.id);
  if (!policy) {
    throw new Error(`runMonitorCheck: no fetcher policy configured for site: ${site.id}`);
  }

  // 2. 冪等な Job 起動 (SPEC §10, §17.7)
  const scheduledFor = trigger === 'manual' ? nowIso() : (monitor.nextRunAt ?? nowIso());
  const jobResult = await createCheckJobIfNew(db, { monitorId, scheduledFor, trigger });
  const job = jobResult.row;

  if (!jobResult.inserted) {
    // 既存 Job が見つかった。'pending' は自分自身の deferred 再試行の継続とみなして進める。
    // 'running' は同時実行中の重複起動、それ以外 (succeeded/failed/policy_stopped) は既に
    // このスロットの処理が完了している。どちらも重複起動防止のため skipped で返す。
    if (job.status !== 'pending') {
      return { kind: 'skipped', nextRunAt: monitor.nextRunAt, changeIds: [] };
    }
  }

  await updateCheckJobStatus(db, job.id, 'running', { startedAt: nowIso() });

  const ctx: CheckContext = {
    env,
    db,
    monitor,
    source,
    site,
    policy,
    job,
    fetchImpl: opts.fetch,
    now: nowFn,
    changeIds: [],
  };

  // Source URL 自体を表す Target (page: そのページ、feed/sitemap: 文書そのもの)
  const target = await upsertTarget(db, { monitorId, url: source.url });

  // 3. SSRF (登録時だけでなく実行直前にも検査する, SPEC §15)
  const staticSsrf = checkUrlForSsrf(source.url);
  const ssrfResult = staticSsrf.allowed
    ? await resolveAndCheck(source.url, { fetchImpl: opts.fetch })
    : staticSsrf;
  if (!ssrfResult.allowed) {
    const fallbackFetcherId = policy.orderList[0]?.fetcherId ?? 'unknown';
    await createCheckAttempt(db, {
      checkJobId: job.id,
      targetId: target.id,
      fetcherId: fallbackFetcherId,
      attemptIndex: 0,
      outcome: 'failure',
      failureClass: 'ssrf_blocked',
      errorMessage: `ssrf_blocked: ${ssrfResult.reason ?? 'unknown'}`,
    });
    return finishJob(ctx, 'failed');
  }

  // 4. robots.txt (SPEC §9, ADR-0008/0009)
  const origin = new URL(source.url).origin;
  const robotsMode = await getRobotsMode(db, site.id, origin);
  const decision = await checkRobots(origin, source.url, {
    fetchImpl: opts.fetch,
    userAgent: env.USER_AGENT,
    cache: createD1RobotsCache(db),
    now: nowFn,
  });
  const evaluation = await createRobotsEvaluation(db, {
    origin,
    verdict: decision.verdict,
    robotsUrl: decision.robotsUrl,
    checkedAt: decision.fetchedAt,
    userAgentGroup: decision.userAgentGroup,
    matchedRule: decision.matchedRule,
    unavailable: decision.unavailable,
    robotsWouldBlock: decision.verdict === 'disallowed',
  });

  if (decision.verdict === 'disallowed' && robotsMode === 'enforce') {
    const fallbackFetcherId = policy.orderList[0]?.fetcherId ?? 'unknown';
    await createCheckAttempt(db, {
      checkJobId: job.id,
      targetId: target.id,
      fetcherId: fallbackFetcherId,
      attemptIndex: 0,
      outcome: 'failure',
      failureClass: 'blocked_by_robots',
      errorMessage: `blocked_by_robots: ${decision.robotsUrl} (${decision.matchedRule ?? 'unavailable'})`,
    });
    await updateCheckJobStatus(db, job.id, 'policy_stopped', { finishedAt: nowIso() });
    await policyStopMonitor(db, monitorId, {
      stopReason: `robots.txt disallow: ${decision.matchedRule ?? 'unavailable (5xx/network error)'}`,
      robotsEvaluationId: evaluation.id,
    });
    return { kind: 'policy_stopped', nextRunAt: null, changeIds: [] };
  }
  // decision.verdict === 'disallowed' && robotsMode === 'ignore' の場合は
  // robotsWouldBlock=true を記録済みのまま続行する (ADR-0009)。

  // 5. Host lease (canonical origin 単位, SPEC §11)
  const limiterFactory = opts.hostLimiter ?? hostLimiterFactory(env);
  const limiter: HostLimiter = limiterFactory(origin);
  const lease = await limiter.acquire();
  if (!lease.granted) {
    // 同一 scheduled slot のまま 'pending' に留め、次の再試行 (retryAfterMs 後) が
    // createCheckJobIfNew で同じ Job を見つけて継続できるようにする (冪等キーを壊さない)。
    await updateCheckJobStatus(db, job.id, 'pending');
    return {
      kind: 'deferred',
      nextRunAt: monitor.nextRunAt,
      retryAfterMs: lease.retryAfterMs ?? 5000,
      changeIds: [],
    };
  }

  // 6. Fetcher Policy に従った fetch (ADR-0005)
  const latestSnapshot = await getLatestSnapshotForTarget(db, target.id);
  const { outcome, lastAttemptId } = await fetchTargetThroughPolicy(ctx, target.id, source.url, {
    etag: latestSnapshot?.etag ?? null,
    lastModified: latestSnapshot?.lastModified ?? null,
  });

  await limiter.release(lease.leaseId as string, {
    failureClass: outcome.ok ? null : outcome.failureClass,
    retryAfterSeconds: outcome.ok ? null : outcome.retryAfterSeconds,
  });

  if (!outcome.ok) {
    return finishJob(ctx, 'failed');
  }

  await setTargetLastChecked(db, target.id, nowIso());

  // 304 Not Modified: 変更なしの成功。新規 Snapshot は作らない。
  if (outcome.notModified || !outcome.body) {
    return finishJob(ctx, 'succeeded');
  }

  // 7. Source 種別ごとの内容処理
  if (source.type === 'page') {
    await processPageContent(ctx, target, latestSnapshot, lastAttemptId, outcome as FetchSuccess, outcome.body);
  } else {
    await processFeedContent(ctx, target, lastAttemptId, outcome as FetchSuccess, outcome.body);
  }

  // 8. 通知ファンアウトは pageContent/feed 内で change 挿入時に完了済み。
  // 9. Job 確定 + 次回スケジュール
  return finishJob(ctx, 'succeeded');
}
