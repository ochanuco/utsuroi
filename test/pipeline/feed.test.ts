import { describe, expect, it, vi } from 'vitest';
import { runMonitorCheck } from '../../src/pipeline/runCheck';
import type { Env } from '../../src/shared/env';
import { listChangesByMonitor, listDeliveriesByChange, listTargetsByMonitor } from '../../src/db';
import { buildPipelineFixture, db, fakeEnv, grantingLimiter, routedFetch } from './helpers';

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

  it('updates last_checked_at for a child sitemap that returns 304 Not Modified (still a successful check)', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/sitemap-index-nm.xml',
    });
    const fetchStubV1 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-index-nm.xml': () =>
        new Response(SITEMAP_INDEX_BODY, { status: 200, headers: { 'content-type': 'application/xml' } }),
      'https://example.com/sitemap-child.xml': () =>
        new Response(CHILD_SITEMAP_BODY, {
          status: 200,
          headers: { 'content-type': 'application/xml', etag: '"child-v1"' },
        }),
    });
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV1, hostLimiter: grantingLimiter() },
    );

    const targetsAfterFirst = await listTargetsByMonitor(db(), monitor.id);
    const childTargetFirst = targetsAfterFirst.find((t) => t.url === 'https://example.com/sitemap-child.xml');
    expect(childTargetFirst?.lastCheckedAt).toBeTruthy();
    const lastCheckedAfterFirst = childTargetFirst!.lastCheckedAt;

    // second check: the child sitemap now returns 304 Not Modified. This is still a
    // *successful* check of the child (just no new body to parse), so last_checked_at
    // must be updated even though processFeedItems is skipped for it.
    const fetchStubV2 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-index-nm.xml': () =>
        new Response(SITEMAP_INDEX_BODY, { status: 200, headers: { 'content-type': 'application/xml' } }),
      'https://example.com/sitemap-child.xml': () =>
        new Response(null, { status: 304, headers: { etag: '"child-v1"' } }),
    });
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV2, hostLimiter: grantingLimiter() },
    );

    const targetsAfterSecond = await listTargetsByMonitor(db(), monitor.id);
    const childTargetSecond = targetsAfterSecond.find((t) => t.url === 'https://example.com/sitemap-child.xml');
    expect(childTargetSecond?.lastCheckedAt).toBeTruthy();
    expect(childTargetSecond!.lastCheckedAt).not.toBe(lastCheckedAfterFirst);

    // no new items were (re-)processed from the notModified child, so no new Changes appear
    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(2); // unchanged from the first check
  });
});

const SITEMAP_WITH_LASTMOD_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/dup-recovery-page</loc><lastmod>2026-01-01T00:00:00Z</lastmod></url>
</urlset>`;

describe('processFeedItems: duplicate dedupeKey recovery (at-least-once delivery, SPEC §17.7-8)', () => {
  it('recreates delivery/notify for a duplicate updated-item Change when a prior run crashed before delivery', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap',
      sourceUrl: 'https://example.com/sitemap-dup.xml',
    });
    const fetchStub = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-dup.xml': () =>
        new Response(SITEMAP_WITH_LASTMOD_BODY, { status: 200, headers: { 'content-type': 'application/xml' } }),
    });

    // call 1: brand-new Target -> kind:'new' Change (dedupeKey = stableKey)
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );

    // call 2: same lastmod -> existing-Target branch -> kind:'updated' Change inserted
    // (dedupeKey = `${stableKey}:${updatedAt}`, not seen before)
    const secondSend = vi.fn();
    const secondResult = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: secondSend } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );
    expect(secondResult.changeIds).toHaveLength(1);
    expect(secondSend).toHaveBeenCalledTimes(1);

    const changes = await listChangesByMonitor(db(), monitor.id);
    const updatedChange = changes.find((c) => c.kind === 'updated');
    expect(updatedChange).toBeTruthy();

    const deliveriesBefore = await listDeliveriesByChange(db(), updatedChange!.id);
    expect(deliveriesBefore).toHaveLength(1);

    // Simulate a crash after the Change row committed but before the Delivery/enqueue completed.
    await db().prepare('DELETE FROM deliveries WHERE change_id = ?').bind(updatedChange!.id).run();

    // call 3: identical lastmod again -> insertChangeIfNew hits the (monitor_id, dedupe_key)
    // conflict from call 2 and returns inserted:false, but delivery/notify must still recover
    // because no Delivery existed yet for this Change.
    const thirdSend = vi.fn();
    const thirdResult = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: thirdSend } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );

    expect(thirdResult.changeIds).toHaveLength(0); // duplicate, not newly detected this run
    const changesAfter = await listChangesByMonitor(db(), monitor.id);
    expect(changesAfter.filter((c) => c.kind === 'updated')).toHaveLength(1); // no duplicate row

    const deliveriesAfter = await listDeliveriesByChange(db(), updatedChange!.id);
    expect(deliveriesAfter).toHaveLength(1);
    expect(thirdSend).toHaveBeenCalledTimes(1);
  });
});
