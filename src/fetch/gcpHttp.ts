/**
 * GCP Executor (Cloud Run, fetcher 'gcp-http') への push 型取得 (ADR-0021)。
 * Worker は署名付き JSON を POST し、Executor が実際の取得 (SSRF 検査・リダイレクト追跡・サイズ制限)
 * を行って応答を base64 で返す。応答は cf-http と同じ分類器 (handleTerminalResponse) に通す。
 */
import { DEFAULT_FETCH_LIMITS } from '../shared/contracts';
import type { FetchOutcome } from '../shared/contracts';
import type { FailureClass } from '../shared/types';
import { signExecutorToken } from './executorToken';
import { classifyNetworkError, failure, handleTerminalResponse, readBodyWithLimit } from './http';
import type { FetcherInvocation } from './registry';

export const GCP_HTTP_AUDIENCE = 'gcp-http';

/** Executor が kind='error' で返してよい分類。これ以外は契約違反として internal_error にする */
const EXECUTOR_FAILURE_CLASSES: ReadonlySet<string> = new Set<FailureClass>([
  'ssrf_blocked',
  'timeout',
  'network_error',
  'too_large',
]);

/** base64 化と JSON 包みによる膨張分。Executor 応答の読み取り上限に使う */
function responseLimit(maxBytes: number): number {
  return Math.ceil((maxBytes * 4) / 3) + 16 * 1024;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function gcpHttpFetch(inv: FetcherInvocation): Promise<FetchOutcome> {
  const { env } = inv;
  const endpointRaw = env.GCP_EXECUTOR_URL?.trim() ?? '';
  if (endpointRaw === '') {
    return failure('internal_error', null, 'gcp-http is not configured: GCP_EXECUTOR_URL is empty', null);
  }
  const signingKey = env.GCP_EXECUTOR_SIGNING_KEY?.trim() ?? '';
  if (signingKey === '') {
    return failure('internal_error', null, 'gcp-http is not configured: GCP_EXECUTOR_SIGNING_KEY is not set', null);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(endpointRaw);
  } catch {
    return failure('internal_error', null, 'gcp-http is misconfigured: GCP_EXECUTOR_URL is not a valid URL', null);
  }
  if (endpoint.protocol !== 'https:') {
    return failure('internal_error', null, 'gcp-http is misconfigured: GCP_EXECUTOR_URL must be https', null);
  }

  const guard = inv.urlGuard(inv.url);
  if (!guard.allowed) {
    return failure('ssrf_blocked', null, `url blocked by ssrf policy: ${guard.reason ?? 'unknown'}`, null);
  }

  const limits = DEFAULT_FETCH_LIMITS;
  const startedAt = Date.now();

  const headers: Record<string, string> = {
    'user-agent': inv.userAgent,
    'accept-language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
    referer: inv.url,
  };
  if (inv.etag) headers['if-none-match'] = inv.etag;
  if (inv.lastModified) headers['if-modified-since'] = inv.lastModified;
  const body = new TextEncoder().encode(JSON.stringify({ url: inv.url, maxBytes: limits.maxBytes, headers }));

  let token: string;
  try {
    token = await signExecutorToken({ signingKeyPem: signingKey, audience: GCP_HTTP_AUDIENCE, body });
  } catch (err) {
    return failure(
      'internal_error',
      null,
      `gcp-http failed to sign request: ${err instanceof Error ? err.message : String(err)}`,
      null,
    );
  }

  const fetchImpl = inv.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint.toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
      redirect: 'manual',
      // Executor 自身の総タイムアウト (25s) より後に切る。
      signal: AbortSignal.timeout(limits.totalTimeoutMs),
    });
  } catch (err) {
    return classifyNetworkError(err);
  }

  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return failure('network_error', null, `gcp executor unavailable (status ${response.status})`, null);
    }
    // 401/403 (署名・IAM 拒否)、400、413 等は設定不整合であり、他の Fetcher へ進んでも直らない。
    return failure('internal_error', null, `gcp executor rejected the request (status ${response.status})`, null);
  }

  const limit = responseLimit(limits.maxBytes);
  let bytes: Uint8Array | null;
  try {
    const read = await readBodyWithLimit(response, limit);
    bytes = read.tooLarge ? null : read.body;
  } catch (err) {
    return classifyNetworkError(err);
  }
  if (bytes === null) {
    return failure('internal_error', null, 'gcp executor response exceeded the expected size', null);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return failure('internal_error', null, 'gcp executor returned invalid JSON', null);
  }
  if (!isRecord(payload)) {
    return failure('internal_error', null, 'gcp executor returned an unexpected payload', null);
  }

  if (payload.kind === 'error') {
    const failureClass = typeof payload.failureClass === 'string' ? payload.failureClass : '';
    const message = typeof payload.message === 'string' ? payload.message : 'gcp executor reported a failure';
    if (!EXECUTOR_FAILURE_CLASSES.has(failureClass)) {
      return failure('internal_error', null, `gcp executor returned unknown failure class: ${failureClass}`, null);
    }
    return failure(failureClass as FailureClass, null, `gcp-http: ${message}`, null);
  }

  if (payload.kind !== 'response') {
    return failure('internal_error', null, 'gcp executor returned an unexpected payload', null);
  }
  const { status, url: finalUrl, headers: upstreamHeaders, body: bodyBase64, truncated } = payload;
  if (
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < 200 ||
    status > 599 ||
    typeof finalUrl !== 'string' ||
    !isRecord(upstreamHeaders) ||
    typeof bodyBase64 !== 'string' ||
    typeof truncated !== 'boolean'
  ) {
    return failure('internal_error', null, 'gcp executor returned a malformed response', null);
  }

  // cf-http は 2xx と 403 の本文を上限まで読み、超過すれば too_large にする。同じ扱いに揃える。
  if (truncated && ((status >= 200 && status < 300) || status === 403)) {
    return failure('too_large', status, `response body exceeded maxBytes (${limits.maxBytes})`, null);
  }
  const upstreamBody = decodeBase64(bodyBase64);
  if (upstreamBody === null) {
    return failure('internal_error', null, 'gcp executor returned an invalid body encoding', null);
  }

  const syntheticHeaders = new Headers();
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (typeof value !== 'string') continue;
    try {
      syntheticHeaders.set(name, value);
    } catch {
      // 不正なヘッダは無視する
    }
  }
  const nullBodyStatus = status === 204 || status === 205 || status === 304;
  const synthetic = new Response(nullBodyStatus || upstreamBody.byteLength === 0 ? null : upstreamBody, {
    status,
    headers: syntheticHeaders,
  });

  return handleTerminalResponse(synthetic, finalUrl, { url: inv.url, userAgent: inv.userAgent }, limits, startedAt);
}
