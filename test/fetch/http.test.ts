import { describe, expect, it } from 'vitest';
import { httpFetch } from '../../src/fetch/http';
import type { FetchRequest } from '../../src/shared/contracts';

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function baseRequest(overrides: Partial<FetchRequest> = {}): FetchRequest {
  return {
    url: 'https://example.com/page',
    userAgent: 'UtsuroiBot/0.1',
    ...overrides,
  };
}

describe('httpFetch: request construction', () => {
  it('sends GET with User-Agent, extra headers, and conditional headers', async () => {
    let capturedInit: RequestInit | undefined;
    const stub: FetchStub = async (_url, init) => {
      capturedInit = init;
      return new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } });
    };

    const req = baseRequest({
      headers: { 'X-Custom': 'abc' },
      etag: '"v1"',
      lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
    });

    const outcome = await httpFetch(req, { fetch: stub });

    expect(outcome.ok).toBe(true);
    expect(capturedInit?.method).toBe('GET');
    expect(capturedInit?.redirect).toBe('manual');
    const headers = capturedInit?.headers as Headers;
    expect(headers.get('user-agent')).toBe('UtsuroiBot/0.1');
    expect(headers.get('x-custom')).toBe('abc');
    expect(headers.get('if-none-match')).toBe('"v1"');
    expect(headers.get('if-modified-since')).toBe('Wed, 01 Jan 2026 00:00:00 GMT');
  });

  it('does not set conditional headers when etag/lastModified are absent', async () => {
    let capturedInit: RequestInit | undefined;
    const stub: FetchStub = async (_url, init) => {
      capturedInit = init;
      return new Response('hello', { status: 200 });
    };

    await httpFetch(baseRequest(), { fetch: stub });

    const headers = capturedInit?.headers as Headers;
    expect(headers.get('if-none-match')).toBeNull();
    expect(headers.get('if-modified-since')).toBeNull();
  });
});

describe('httpFetch: 304 not modified', () => {
  it('returns ok:true, notModified:true, body:null', async () => {
    const stub: FetchStub = async () =>
      new Response(null, {
        status: 304,
        headers: { etag: '"same"', 'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT' },
      });

    const outcome = await httpFetch(baseRequest({ etag: '"same"' }), { fetch: stub });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.notModified).toBe(true);
      expect(outcome.body).toBeNull();
      expect(outcome.status).toBe(304);
      expect(outcome.etag).toBe('"same"');
      expect(typeof outcome.durationMs).toBe('number');
    }
  });
});

describe('httpFetch: redirects', () => {
  it('follows a redirect and resolves relative Location against the current URL', async () => {
    const calls: string[] = [];
    const stub: FetchStub = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://example.com/start') {
        return new Response(null, { status: 302, headers: { location: '/next' } });
      }
      if (url === 'https://example.com/next') {
        return new Response('done', { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const outcome = await httpFetch(baseRequest({ url: 'https://example.com/start' }), { fetch: stub });

    expect(calls).toEqual(['https://example.com/start', 'https://example.com/next']);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.finalUrl).toBe('https://example.com/next');
    }
  });

  it('fails with network_error when redirects exceed maxRedirects', async () => {
    let callCount = 0;
    const stub: FetchStub = async () => {
      callCount += 1;
      return new Response(null, { status: 302, headers: { location: '/loop' } });
    };

    const outcome = await httpFetch(
      baseRequest({ url: 'https://example.com/start', limits: { maxRedirects: 1 } }),
      { fetch: stub }
    );

    expect(callCount).toBe(2);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureClass).toBe('network_error');
      expect(outcome.message).toContain('too_many_redirects');
    }
  });

  it('fails with network_error (not an uncaught throw) when a redirect Location is unparsable', async () => {
    const stub: FetchStub = async () =>
      new Response(null, { status: 302, headers: { location: 'http://[not-a-valid-host' } });

    const outcome = await httpFetch(baseRequest({ url: 'https://example.com/start' }), { fetch: stub });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureClass).toBe('network_error');
      expect(outcome.message).toContain('redirect Location');
    }
  });

  it('re-validates each redirect hop against urlGuard and blocks a hop that resolves to a disallowed URL', async () => {
    const calls: string[] = [];
    const stub: FetchStub = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://example.com/start') {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const outcome = await httpFetch(baseRequest({ url: 'https://example.com/start' }), {
      fetch: stub,
      urlGuard: (url) => (url.includes('169.254.169.254') ? { allowed: false, reason: 'metadata' } : { allowed: true, reason: null }),
    });

    expect(calls).toEqual(['https://example.com/start']);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureClass).toBe('ssrf_blocked');
    }
  });

  it('applies urlGuard to the initial URL as well', async () => {
    let fetchCalled = false;
    const stub: FetchStub = async () => {
      fetchCalled = true;
      return new Response('hello', { status: 200 });
    };

    const outcome = await httpFetch(baseRequest({ url: 'http://127.0.0.1/' }), {
      fetch: stub,
      urlGuard: () => ({ allowed: false, reason: 'loopback' }),
    });

    expect(fetchCalled).toBe(false);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failureClass).toBe('ssrf_blocked');
  });
});

describe('httpFetch: size limits', () => {
  it('fails with too_large when Content-Length exceeds maxBytes', async () => {
    const stub: FetchStub = async () =>
      new Response('x', {
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-length': '1000' },
      });

    const outcome = await httpFetch(baseRequest({ limits: { maxBytes: 10 } }), { fetch: stub });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureClass).toBe('too_large');
    }
  });

  it('fails with too_large when a streamed body exceeds maxBytes with no Content-Length', async () => {
    const stub: FetchStub = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(20).fill(1));
          controller.enqueue(new Uint8Array(20).fill(2));
          controller.close();
        },
      });
      const response = new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
      response.headers.delete('content-length');
      return response;
    };

    const outcome = await httpFetch(baseRequest({ limits: { maxBytes: 30 } }), { fetch: stub });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureClass).toBe('too_large');
    }
  });

  it('succeeds when the body is within maxBytes', async () => {
    const stub: FetchStub = async () =>
      new Response('small body', { status: 200, headers: { 'content-type': 'text/plain' } });

    const outcome = await httpFetch(baseRequest({ limits: { maxBytes: 1000 } }), { fetch: stub });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.body).not.toBeNull();
      expect(new TextDecoder().decode(outcome.body ?? new Uint8Array())).toBe('small body');
    }
  });
});

describe('httpFetch: content-type validation', () => {
  it('rejects when content-type does not match any allowed prefix', async () => {
    const stub: FetchStub = async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

    const outcome = await httpFetch(baseRequest({ allowedContentTypes: ['text/html'] }), { fetch: stub });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureClass).toBe('invalid_content_type');
    }
  });

  it('accepts a content-type matching an allowed prefix (with charset suffix)', async () => {
    const stub: FetchStub = async () =>
      new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });

    const outcome = await httpFetch(baseRequest({ allowedContentTypes: ['text/html'] }), { fetch: stub });

    expect(outcome.ok).toBe(true);
  });
});

describe('httpFetch: status -> FailureClass mapping', () => {
  it('maps 401 to auth_required', async () => {
    const stub: FetchStub = async () => new Response(null, { status: 401 });
    const outcome = await httpFetch(baseRequest(), { fetch: stub });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failureClass).toBe('auth_required');
  });

  it('maps 407 to auth_required', async () => {
    const stub: FetchStub = async () => new Response(null, { status: 407 });
    const outcome = await httpFetch(baseRequest(), { fetch: stub });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failureClass).toBe('auth_required');
  });

  it('maps a plain 403 (no captcha signal) to http_403', async () => {
    const stub: FetchStub = async () => new Response('forbidden', { status: 403 });
    const outcome = await httpFetch(baseRequest(), { fetch: stub });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failureClass).toBe('http_403');
  });

  it('maps a 403 with a cf-chl-* / cf-mitigated header to captcha_challenge', async () => {
    const stub: FetchStub = async () =>
      new Response('blocked', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    const outcome = await httpFetch(baseRequest(), { fetch: stub });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failureClass).toBe('captcha_challenge');
  });

  it('maps a 403 whose body contains CAPTCHA text to captcha_challenge', async () => {
    const stub: FetchStub = async () =>
      new Response('<html>Please complete the CAPTCHA to continue</html>', { status: 403 });
    const outcome = await httpFetch(baseRequest(), { fetch: stub });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failureClass).toBe('captcha_challenge');
  });

  it('maps 404 and 410 to not_found', async () => {
    for (const status of [404, 410]) {
      const stub: FetchStub = async () => new Response(null, { status });
      const outcome = await httpFetch(baseRequest(), { fetch: stub });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.failureClass).toBe('not_found');
    }
  });

  it('maps 429 to http_429 and parses an integer Retry-After', async () => {
    const stub: FetchStub = async () =>
      new Response(null, { status: 429, headers: { 'retry-after': '120' } });
    const outcome = await httpFetch(baseRequest(), { fetch: stub });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureClass).toBe('http_429');
      expect(outcome.retryAfterSeconds).toBe(120);
    }
  });

  it('maps 429 and parses an HTTP-date Retry-After', async () => {
    const future = new Date(Date.now() + 60_000);
    const stub: FetchStub = async () =>
      new Response(null, { status: 429, headers: { 'retry-after': future.toUTCString() } });
    const outcome = await httpFetch(baseRequest(), { fetch: stub });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureClass).toBe('http_429');
      expect(outcome.retryAfterSeconds).not.toBeNull();
      expect(outcome.retryAfterSeconds as number).toBeGreaterThan(55);
      expect(outcome.retryAfterSeconds as number).toBeLessThan(65);
    }
  });

  it('maps 5xx to http_5xx', async () => {
    const stub: FetchStub = async () => new Response(null, { status: 503 });
    const outcome = await httpFetch(baseRequest(), { fetch: stub });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failureClass).toBe('http_5xx');
  });

  it('maps a thrown TypeError (network failure) to network_error', async () => {
    const stub: FetchStub = async () => {
      throw new TypeError('fetch failed: connection refused');
    };
    const outcome = await httpFetch(baseRequest(), { fetch: stub });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failureClass).toBe('network_error');
  });

  it('maps an aborted request due to totalTimeoutMs to timeout', async () => {
    const stub: FetchStub = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject((init.signal as AbortSignal).reason);
        });
      });

    const outcome = await httpFetch(baseRequest({ limits: { totalTimeoutMs: 5 } }), { fetch: stub });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failureClass).toBe('timeout');
  });
});
