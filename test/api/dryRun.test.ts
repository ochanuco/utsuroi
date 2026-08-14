import { describe, expect, it, vi } from 'vitest';
import { buildTestApp, jsonHeaders, testEnv } from './helpers';

/** URL 前方一致でレスポンスを返す fetch スタブ。未登録URLは 404 */
function routedFetch(
  handlers: Record<string, () => Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (url.startsWith(prefix)) return handler();
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function htmlResponse(html: string, contentType = 'text/html; charset=utf-8'): Response {
  return new Response(html, { status: 200, headers: { 'content-type': contentType } });
}

async function dryRun(app: ReturnType<typeof buildTestApp>['app'], url: string): Promise<Response> {
  return app.request(
    '/api/dry-run',
    { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ url }) },
    testEnv(),
  );
}

describe('POST /api/dry-run (ADR-0018)', () => {
  it('returns the robots verdict and the page <title> when everything succeeds', async () => {
    const { app } = buildTestApp({
      fetchImpl: routedFetch({
        'https://example.com/robots.txt': () => new Response('User-agent: *\nDisallow:', { status: 200 }),
        'https://example.com/page': () => htmlResponse('<html><head><title>ページの題名</title></head></html>'),
      }),
    });

    const res = await dryRun(app, 'https://example.com/page');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.robots.reachable).toBe(true);
    expect(body.robots.verdict).toBe('allowed');
    expect(body.robots.robots_url).toBe('https://example.com/robots.txt');
    expect(body.fetch.ok).toBe(true);
    expect(body.fetch.status).toBe(200);
    expect(body.title).toBe('ページの題名');
    expect(body.title_skip_reason).toBeNull();
  });

  it('still fetches the title when robots.txt disallows, and reports the verdict (ADR-0018)', async () => {
    const { app } = buildTestApp({
      fetchImpl: routedFetch({
        'https://example.com/robots.txt': () =>
          new Response('User-agent: *\nDisallow: /private', { status: 200 }),
        'https://example.com/private/page': () =>
          htmlResponse('<html><head><title>禁止領域のページ</title></head></html>'),
      }),
    });

    const res = await dryRun(app, 'https://example.com/private/page');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.robots.verdict).toBe('disallowed');
    expect(body.robots.reachable).toBe(true);
    // DryRun は robots を強制しない。判定は返しつつ title は取得する
    expect(body.title).toBe('禁止領域のページ');
  });

  it('reports robots.txt as unreachable on 5xx but still returns the title', async () => {
    const { app } = buildTestApp({
      fetchImpl: routedFetch({
        'https://example.com/robots.txt': () => new Response('boom', { status: 503 }),
        'https://example.com/page': () => htmlResponse('<html><head><title>タイトル</title></head></html>'),
      }),
    });

    const res = await dryRun(app, 'https://example.com/page');
    const body = (await res.json()) as any;

    expect(body.robots.reachable).toBe(false);
    expect(body.robots.verdict).toBe('disallowed');
    expect(body.robots.user_agent_group).toBe('unavailable');
    expect(body.title).toBe('タイトル');
  });

  it('returns a skip reason instead of a title for non-HTML responses', async () => {
    const { app } = buildTestApp({
      fetchImpl: routedFetch({
        'https://example.com/robots.txt': () => new Response('User-agent: *\nDisallow:', { status: 200 }),
        'https://example.com/feed.xml': () =>
          new Response('<rss></rss>', { status: 200, headers: { 'content-type': 'application/xml' } }),
      }),
    });

    const res = await dryRun(app, 'https://example.com/feed.xml');
    const body = (await res.json()) as any;

    expect(body.fetch.ok).toBe(true);
    expect(body.title).toBeNull();
    expect(body.title_skip_reason).toContain('non-html content-type');
  });

  it('reports a failed page fetch without failing the request', async () => {
    const { app } = buildTestApp({
      fetchImpl: routedFetch({
        'https://example.com/robots.txt': () => new Response('User-agent: *\nDisallow:', { status: 200 }),
        'https://example.com/missing': () => new Response('nope', { status: 404 }),
      }),
    });

    const res = await dryRun(app, 'https://example.com/missing');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.fetch.ok).toBe(false);
    expect(body.fetch.status).toBe(404);
    expect(body.title).toBeNull();
    expect(body.title_skip_reason).toContain('fetch failed');
  });

  it('rejects a URL blocked by the SSRF check (400) without fetching anything', async () => {
    const fetchSpy = vi.fn();
    const { app } = buildTestApp({
      fetchImpl: (async (...args: unknown[]) => {
        fetchSpy(...args);
        return new Response('should not be reached', { status: 200 });
      }) as unknown as typeof fetch,
    });

    const res = await dryRun(app, 'http://127.0.0.1/admin');
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('ssrf_blocked');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects non-http(s) schemes (400)', async () => {
    const { app } = buildTestApp();
    const res = await dryRun(app, 'ftp://example.com/file');
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('unsupported_scheme');
  });
});
