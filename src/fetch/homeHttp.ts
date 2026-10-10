/**
 * Home Runner (pull 型, fetcher 'home-http') による取得 (ADR-0023)。
 * CrawlerObject へ job を投入し、Runner の結果か期限が来るまで待つ。Runner 不在・期限切れ・RPC 失敗は
 * executor_unavailable として返し、後続 Fetcher へ進めるようにする。
 */
import { crawlerStub } from '../do/crawlerObject';
import { resolveAndCheck, checkUrlForSsrf } from '../net';
import { RUNNER_REQUEST_HEADERS } from '../runner/protocol';
import { DEFAULT_FETCH_LIMITS } from '../shared/contracts';
import type { FetchOutcome } from '../shared/contracts';
import { outcomeFromExecutorPayload } from './gcpHttp';
import { failure } from './http';
import type { FetcherInvocation } from './registry';

export const HOME_EXECUTOR_ID = 'home';

const ALLOWED_HEADERS: ReadonlySet<string> = new Set(RUNNER_REQUEST_HEADERS);

function buildHeaders(inv: FetcherInvocation): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(inv.headers ?? {})) {
    const key = name.toLowerCase();
    if (ALLOWED_HEADERS.has(key)) headers[key] = value;
  }
  headers['user-agent'] = inv.userAgent;
  headers['accept-language'] = 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7';
  headers.referer = inv.url;
  if (inv.etag) headers['if-none-match'] = inv.etag;
  if (inv.lastModified) headers['if-modified-since'] = inv.lastModified;
  return headers;
}

export async function homeHttpFetch(inv: FetcherInvocation): Promise<FetchOutcome> {
  const guard = inv.urlGuard(inv.url);
  if (!guard.allowed) {
    return failure('ssrf_blocked', null, `url blocked by ssrf policy: ${guard.reason ?? 'unknown'}`, null);
  }
  // Runner は家庭内 LAN に繋がるため、投入前に名前解決結果まで検査する (Runner 側の検査とは独立)
  const dynamic = await resolveAndCheck(inv.url, { fetchImpl: inv.fetchImpl, resolver: inv.ssrfResolver });
  if (!dynamic.allowed) {
    return failure('ssrf_blocked', null, `url blocked by ssrf policy: ${dynamic.reason ?? 'unknown'}`, null);
  }

  const limits = DEFAULT_FETCH_LIMITS;
  const startedAt = Date.now();
  const jobId = crypto.randomUUID();
  if (inv.jobRef) inv.jobRef.executorJobId = jobId;

  let outcome: Awaited<ReturnType<ReturnType<typeof crawlerStub>['submitAndWait']>>;
  try {
    outcome = await crawlerStub(inv.env, HOME_EXECUTOR_ID).submitAndWait(
      {
        executorId: HOME_EXECUTOR_ID,
        jobId,
        fetchMode: 'http',
        request: { url: inv.url, maxBytes: limits.maxBytes, headers: buildHeaders(inv) },
      },
      inv.submitLimits,
    );
  } catch (err) {
    console.error(JSON.stringify({ event: 'home_http_rpc_failed', jobId, error: err instanceof Error ? err.message : String(err) }));
    return failure('executor_unavailable', null, 'home-http: executor is unavailable (rpc failed)', null);
  }

  if (outcome.kind === 'unavailable') {
    return failure('executor_unavailable', null, `home-http: executor is unavailable (${outcome.reason})`, null);
  }

  return outcomeFromExecutorPayload(
    outcome.result as unknown as Record<string, unknown>,
    inv,
    limits,
    startedAt,
    { label: 'home runner', prefix: 'home-http' },
    // Runner が辿った最終 URL も Worker 側で再検査する
    checkUrlForSsrf,
  );
}
