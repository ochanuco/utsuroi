import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { runMonitorCheck } from '../../src/pipeline/runCheck';
import type { Env } from '../../src/shared/env';
import type { HostLimiter } from '../../src/shared/contracts';
import { listChangesByMonitor, listTargetsByMonitor } from '../../src/db';
import { buildPipelineFixture, db, routedFetch } from './helpers';

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, ...overrides } as Env;
}

function grantingLimiter(): (origin: string) => HostLimiter {
  let counter = 0;
  return () => ({
    acquire: async () => ({ granted: true, leaseId: `lease-${counter++}`, retryAfterMs: null }),
    release: async () => {},
  });
}

const RSS_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <item>
      <title>First Post</title>
      <link>https://example.com/posts/1</link>
      <guid>urn:uuid:1</guid>
      <pubDate>Wed, 02 Oct 2002 08:00:00 EST</pubDate>
      <description>first body</description>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://example.com/posts/2</link>
      <guid>urn:uuid:2</guid>
      <pubDate>Thu, 03 Oct 2002 08:00:00 EST</pubDate>
      <description>second body</description>
    </item>
  </channel>
</rss>`;

describe('runMonitorCheck: rss feed (SPEC §17.8: no duplicate entry notifications)', () => {
  it('detects new entries once, and a re-fetch of the unchanged feed creates zero new Changes', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'rss',
      sourceUrl: 'https://example.com/feed.xml',
    });
    const fetchStub = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/feed.xml': () =>
        new Response(RSS_BODY, { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
    });

    const first = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );
    expect(first.kind).toBe('completed');
    expect(first.changeIds).toHaveLength(2);

    const targets = await listTargetsByMonitor(db(), monitor.id);
    // feed 文書自体の Target (1) + item Target (2)
    expect(targets).toHaveLength(3);

    const second = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );
    expect(second.kind).toBe('completed');
    expect(second.changeIds).toHaveLength(0);

    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(2);
  });
});

const SITEMAP_INDEX_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-child.xml</loc></sitemap>
</sitemapindex>`;

const CHILD_SITEMAP_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc><lastmod>2026-01-01</lastmod></url>
  <url><loc>https://example.com/b</loc><lastmod>2026-01-02</lastmod></url>
</urlset>`;

describe('runMonitorCheck: sitemap-index (SPEC §17.9: detects new URLs under a Sitemap Index)', () => {
  it('expands the child sitemap and detects new URLs underneath it', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/sitemap-index.xml',
    });
    const fetchStub = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-index.xml': () =>
        new Response(SITEMAP_INDEX_BODY, { status: 200, headers: { 'content-type': 'application/xml' } }),
      'https://example.com/sitemap-child.xml': () =>
        new Response(CHILD_SITEMAP_BODY, { status: 200, headers: { 'content-type': 'application/xml' } }),
    });

    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );

    expect(result.kind).toBe('completed');
    expect(result.changeIds).toHaveLength(2);
    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes.map((c) => c.targetUrl).sort()).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
    expect(changes.every((c) => c.kind === 'new')).toBe(true);
  });
});
