/**
 * 制限付き HTTP フェッチャ (SPEC §7.1, §8)
 *
 * GET のみ、条件付きリクエスト (ETag / Last-Modified)、手動リダイレクト追跡、
 * サイズ・時間上限、Content-Type 検証、ステータス→FailureClass 分類を行う。
 */
import { DEFAULT_FETCH_LIMITS } from '../shared/contracts';
import type { FetchFailure, FetchLimits, FetchOutcome, FetchRequest } from '../shared/contracts';
import type { FailureClass } from '../shared/types';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

function buildRequestHeaders(req: FetchRequest): Headers {
  const headers = new Headers();
  headers.set('user-agent', req.userAgent);
  if (req.headers) {
    for (const [key, value] of Object.entries(req.headers)) {
      headers.set(key, value);
    }
  }
  if (req.etag) {
    headers.set('if-none-match', req.etag);
  }
  if (req.lastModified) {
    headers.set('if-modified-since', req.lastModified);
  }
  return headers;
}

function failure(
  failureClass: FailureClass,
  status: number | null,
  message: string,
  retryAfterSeconds: number | null
): FetchFailure {
  return { ok: false, failureClass, status, message, retryAfterSeconds };
}

async function drainBody(response: Response): Promise<void> {
  if (response.body) {
    try {
      await response.body.cancel();
    } catch {
      // ignore drain errors; we are discarding the body regardless.
    }
  }
}

function classifyNetworkError(err: unknown): FetchFailure {
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return failure('timeout', null, `request timed out: ${err.message || err.name}`, null);
  }
  const message = err instanceof Error ? err.message : String(err);
  return failure('network_error', null, message, null);
}

interface BoundedBodyResult {
  body: Uint8Array | null;
  tooLarge: boolean;
}

/** Content-Length 事前検査 + ストリーム読みで maxBytes を強制する */
async function readBodyWithLimit(response: Response, maxBytes: number): Promise<BoundedBodyResult> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await drainBody(response);
      return { body: null, tooLarge: true };
    }
  }

  if (!response.body) {
    return { body: new Uint8Array(0), tooLarge: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        return { body: null, tooLarge: true };
      }
      chunks.push(value);
    }
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: combined, tooLarge: false };
}

function safeDecodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
  } catch {
    return '';
  }
}

function matchesAllowedContentType(contentType: string, allowed: string[]): boolean {
  const normalized = contentType.toLowerCase();
  return allowed.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
}

function detectCaptchaSignal(headers: Headers, bodyText: string): boolean {
  for (const key of headers.keys()) {
    const lower = key.toLowerCase();
    if (lower.startsWith('cf-chl-') || lower === 'cf-mitigated') {
      return true;
    }
  }
  const lowerBody = bodyText.toLowerCase();
  return lowerBody.includes('captcha') || lowerBody.includes('challenge');
}

/** Retry-After: 秒数、または RFC 7231 HTTP-date のいずれにも対応する */
function parseRetryAfterHeader(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diffSeconds = Math.round((dateMs - Date.now()) / 1000);
    return diffSeconds > 0 ? diffSeconds : 0;
  }
  return null;
}

async function handleTerminalResponse(
  response: Response,
  finalUrl: string,
  req: FetchRequest,
  limits: FetchLimits,
  startedAt: number
): Promise<FetchOutcome> {
  const status = response.status;
  const contentType = response.headers.get('content-type');
  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');

  if (status === 304) {
    await drainBody(response);
    return {
      ok: true,
      status,
      notModified: true,
      finalUrl,
      contentType,
      etag,
      lastModified,
      body: null,
      durationMs: Date.now() - startedAt,
    };
  }

  if (status === 401 || status === 407) {
    await drainBody(response);
    return failure('auth_required', status, `authentication required (status ${status})`, null);
  }

  if (status === 403) {
    const { body, tooLarge } = await readBodyWithLimit(response, limits.maxBytes);
    if (tooLarge) {
      return failure('too_large', status, `response body exceeded maxBytes (${limits.maxBytes})`, null);
    }
    const bodyText = body ? safeDecodeText(body) : '';
    if (detectCaptchaSignal(response.headers, bodyText)) {
      return failure('captcha_challenge', status, 'captcha/bot challenge detected on 403 response', null);
    }
    return failure('http_403', status, 'forbidden (403)', null);
  }

  if (status === 404 || status === 410) {
    await drainBody(response);
    return failure('not_found', status, `resource not found (status ${status})`, null);
  }

  if (status === 429) {
    await drainBody(response);
    const retryAfterSeconds = parseRetryAfterHeader(response.headers.get('retry-after'));
    return failure('http_429', status, 'rate limited (429)', retryAfterSeconds);
  }

  if (status >= 500 && status < 600) {
    await drainBody(response);
    return failure('http_5xx', status, `server error (status ${status})`, null);
  }

  if (status >= 200 && status < 300) {
    if (req.allowedContentTypes && req.allowedContentTypes.length > 0) {
      if (!contentType || !matchesAllowedContentType(contentType, req.allowedContentTypes)) {
        await drainBody(response);
        return failure(
          'invalid_content_type',
          status,
          `content-type '${contentType ?? '(none)'}' not in allowed list`,
          null
        );
      }
    }

    const { body, tooLarge } = await readBodyWithLimit(response, limits.maxBytes);
    if (tooLarge) {
      return failure('too_large', status, `response body exceeded maxBytes (${limits.maxBytes})`, null);
    }

    return {
      ok: true,
      status,
      notModified: false,
      finalUrl,
      contentType,
      etag,
      lastModified,
      body,
      durationMs: Date.now() - startedAt,
    };
  }

  // Any other status (unhandled 3xx without a followable meaning, unlisted 4xx, etc.)
  await drainBody(response);
  return failure('network_error', status, `unexpected status ${status}`, null);
}

export async function httpFetch(
  req: FetchRequest,
  opts?: { fetch?: typeof fetch }
): Promise<FetchOutcome> {
  const fetchImpl = opts?.fetch ?? fetch;
  const limits: FetchLimits = { ...DEFAULT_FETCH_LIMITS, ...req.limits };
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(limits.totalTimeoutMs);
  const headers = buildRequestHeaders(req);

  let currentUrl = req.url;
  let redirectsFollowed = 0;

  for (;;) {
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal,
      });
    } catch (err) {
      return classifyNetworkError(err);
    }

    if (isRedirectStatus(response.status)) {
      await drainBody(response);
      const location = response.headers.get('location');
      if (!location) {
        return failure(
          'network_error',
          response.status,
          `redirect status ${response.status} missing Location header`,
          null
        );
      }
      if (redirectsFollowed >= limits.maxRedirects) {
        return failure(
          'network_error',
          response.status,
          `too_many_redirects: exceeded ${limits.maxRedirects} redirects`,
          null
        );
      }
      redirectsFollowed += 1;
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return handleTerminalResponse(response, currentUrl, req, limits, startedAt);
  }
}
