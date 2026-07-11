import { describe, expect, it, vi } from 'vitest';
import { runMonitorCheck } from '../../src/pipeline/runCheck';
import { MAX_FEED_ITEMS_PER_CHECK, processFeedItems } from '../../src/pipeline/feed';
import type { CheckContext } from '../../src/pipeline/types';
import type { Env } from '../../src/shared/env';
import type { FeedItem } from '../../src/shared/contracts';
import {
  insertChangeIfNew,
  listChangesByMonitor,
  listDeliveriesByChange,
  listSnapshotsByMonitor,
  listTargetsByMonitor,
} from '../../src/db';
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

const RSS_BODY_WITH_THIRD_ENTRY = RSS_BODY.replace(
  '</channel>',
  `  <item>
      <title>Third Post</title>
      <link>https://example.com/posts/3</link>
      <guid>urn:uuid:3</guid>
      <pubDate>Fri, 04 Oct 2002 08:00:00 EST</pubDate>
      <description>third body</description>
    </item>
  </channel>`,
);

describe('runMonitorCheck: rss feed (SPEC §17.8: no duplicate entry notifications; feed baseline fix)', () => {
  it('creates zero Changes on the first (baseline) check, then detects only genuinely new entries afterwards', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'rss',
      sourceUrl: 'https://example.com/feed.xml',
    });
    const fetchStubV1 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/feed.xml': () =>
        new Response(RSS_BODY, { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
    });

    // monitor の初回チェック (lastCheckedAt===null) は baseline 確立のみ: 2 entries を
    // Target 化するが Change は1件も作らない (実障害の再現防止, see feed.ts コメント)。
    const first = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV1, hostLimiter: grantingLimiter() },
    );
    expect(first.kind).toBe('completed');
    expect(first.changeIds).toHaveLength(0);

    const targetsAfterFirst = await listTargetsByMonitor(db(), monitor.id);
    // feed 文書自体の Target (1) + item Target (2)
    expect(targetsAfterFirst).toHaveLength(3);
    expect(await listChangesByMonitor(db(), monitor.id)).toHaveLength(0);

    // 2回目チェック: 同一 feed の再取得。新規 URL が無いので Change は引き続き 0。
    const second = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV1, hostLimiter: grantingLimiter() },
    );
    expect(second.kind).toBe('completed');
    expect(second.changeIds).toHaveLength(0);

    // 3回目チェック: feed に新しい entry が1件追加された -> その1件だけ 'new' Change として検出
    const fetchStubV2 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/feed.xml': () =>
        new Response(RSS_BODY_WITH_THIRD_ENTRY, { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
    });
    const third = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV2, hostLimiter: grantingLimiter() },
    );
    expect(third.kind).toBe('completed');
    expect(third.changeIds).toHaveLength(1);

    const changesAfterThird = await listChangesByMonitor(db(), monitor.id);
    expect(changesAfterThird).toHaveLength(1);
    expect(changesAfterThird[0]!.kind).toBe('new');
    expect(changesAfterThird[0]!.targetUrl).toBe('https://example.com/posts/3');

    // 4回目チェック: 同じ内容の再取得は重複通知を作らない (既存 entry の再チェック)
    const fourthSend = vi.fn();
    const fourth = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: fourthSend } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV2, hostLimiter: grantingLimiter() },
    );
    expect(fourth.changeIds).toHaveLength(0);
    expect(fourthSend).not.toHaveBeenCalled();
    expect(await listChangesByMonitor(db(), monitor.id)).toHaveLength(1);
  });
});

const SITEMAP_INDEX_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-child.xml</loc></sitemap>
</sitemapindex>`;

// lastmod をあえて付けていない: 'updated' kind の dedupe は既存の実装をそのまま維持する対象で
// (SPEC の対象外) baseline 導入後の初回以降チェックにおける 'new' 検出だけをこのテストで
// 切り分けて検証するため。lastmod の扱いは 'duplicate dedupeKey recovery' テストで別途検証する。
const CHILD_SITEMAP_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/b</loc></url>
</urlset>`;

describe('runMonitorCheck: sitemap-index (SPEC §17.9: detects new URLs under a Sitemap Index; feed baseline fix)', () => {
  it('registers all URLs as baseline Targets with zero Changes on the first check, then detects only a newly-added URL on the next check', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/sitemap-index.xml',
    });
    const fetchStubV1 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-index.xml': () =>
        new Response(SITEMAP_INDEX_BODY, { status: 200, headers: { 'content-type': 'application/xml' } }),
      'https://example.com/sitemap-child.xml': () =>
        new Response(CHILD_SITEMAP_BODY, { status: 200, headers: { 'content-type': 'application/xml' } }),
    });

    // 初回チェック (baseline): 実障害 (www.hira2.jp, 5,183 URL を初回で全て 'new' 化) の
    // 再発防止。子 sitemap 配下の全 URL を Target 登録するが Change は1件も作らない。
    const first = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV1, hostLimiter: grantingLimiter() },
    );
    expect(first.kind).toBe('completed');
    expect(first.changeIds).toHaveLength(0);

    const targetsAfterFirst = await listTargetsByMonitor(db(), monitor.id);
    // index文書自体 (1) + 子sitemap文書自体 (1) + item a,b (2)
    expect(targetsAfterFirst).toHaveLength(4);
    expect(await listChangesByMonitor(db(), monitor.id)).toHaveLength(0);

    // 2回目チェック: 子 sitemap に新規 URL 'c' が追加された -> それだけが 'new' Change になる。
    // 既存の a, b は Change を生成しない (SPEC §17.8: 同一 entry 重複通知しない)。
    const CHILD_SITEMAP_BODY_V2 = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/b</loc></url>
  <url><loc>https://example.com/c</loc></url>
</urlset>`;
    const fetchStubV2 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-index.xml': () =>
        new Response(SITEMAP_INDEX_BODY, { status: 200, headers: { 'content-type': 'application/xml' } }),
      'https://example.com/sitemap-child.xml': () =>
        new Response(CHILD_SITEMAP_BODY_V2, { status: 200, headers: { 'content-type': 'application/xml' } }),
    });
    const second = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV2, hostLimiter: grantingLimiter() },
    );
    expect(second.kind).toBe('completed');
    expect(second.changeIds).toHaveLength(1);

    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('new');
    expect(changes[0]!.targetUrl).toBe('https://example.com/c');
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
    // 2回の runMonitorCheck 呼び出しが同一ミリ秒内に完了すると lastCheckedAt が偶然
    // 同値になりテストがフレーキーになりうるため、明示的に異なる時刻を注入して決定的にする。
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV1, hostLimiter: grantingLimiter(), now: () => new Date('2026-07-10T00:00:00.000Z') },
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
      { fetch: fetchStubV2, hostLimiter: grantingLimiter(), now: () => new Date('2026-07-10T00:05:00.000Z') },
    );

    const targetsAfterSecond = await listTargetsByMonitor(db(), monitor.id);
    const childTargetSecond = targetsAfterSecond.find((t) => t.url === 'https://example.com/sitemap-child.xml');
    expect(childTargetSecond?.lastCheckedAt).toBeTruthy();
    expect(childTargetSecond!.lastCheckedAt).not.toBe(lastCheckedAfterFirst);

    // 初回チェックは baseline (Change 0件) なので、2回目 (304, 新規本文なし) を経ても
    // Change は引き続き 0 件のまま。
    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(0);
  });
});

const SITEMAP_WITH_LASTMOD_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/dup-recovery-page</loc><lastmod>2026-01-01T00:00:00Z</lastmod></url>
</urlset>`;

describe('processFeedContent: parse failure does not create a Snapshot (CodeRabbit review 2)', () => {
  it('records the fetch as successful but creates no Snapshot when the feed body is unparsable', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'rss',
      sourceUrl: 'https://example.com/broken-feed.xml',
    });
    const fetchStub = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/broken-feed.xml': () =>
        new Response('this is not valid xml <<<', {
          status: 200,
          headers: { 'content-type': 'application/rss+xml' },
        }),
    });

    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );

    // フェッチ自体は成功 (parse_error は attempt レベルでは success 扱い)。
    expect(result.kind).toBe('completed');
    expect(result.changeIds).toHaveLength(0);

    // パース不能な本文からは Snapshot を作らない (以前は parseSource 呼び出し前に
    // createSnapshot していたため、パース失敗時にも Snapshot が残ってしまっていた)。
    const snapshots = await listSnapshotsByMonitor(db(), monitor.id);
    expect(snapshots).toHaveLength(0);
  });
});

describe('processFeedItems: item URLs are re-checked against the SSRF policy (CodeRabbit review 2)', () => {
  it('skips a feed item whose URL is blocked by the SSRF policy, without creating a Target/Change', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'rss',
      sourceUrl: 'https://example.com/ssrf-feed.xml',
    });
    const feedBody = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <item>
      <title>Safe Post</title>
      <link>https://example.com/posts/safe</link>
      <guid>urn:uuid:safe</guid>
    </item>
    <item>
      <title>Blocked Post</title>
      <link>http://169.254.169.254/latest/meta-data</link>
      <guid>urn:uuid:blocked</guid>
    </item>
  </channel>
</rss>`;
    const fetchStub = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/ssrf-feed.xml': () =>
        new Response(feedBody, { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
    });

    // これは monitor の初回チェック (baseline) なので、安全な item も Change は作らない。
    // ここで検証したいのは「blocked URL は Target すら作られない」こと。
    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );

    expect(result.kind).toBe('completed');
    expect(result.changeIds).toHaveLength(0);

    const targets = await listTargetsByMonitor(db(), monitor.id);
    // feed 文書自体の Target (1) + 安全な item Target (1)。ブロックされた item の Target は作られない。
    expect(targets).toHaveLength(2);
    expect(targets.some((t) => t.url === 'http://169.254.169.254/latest/meta-data')).toBe(false);
  });
});

const SITEMAP_WITH_LASTMOD_BODY_V2 = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/dup-recovery-page</loc><lastmod>2026-02-01T00:00:00Z</lastmod></url>
</urlset>`;

describe('processFeedItems: watermark-based updated detection (migrations/0005_target_updated_watermark.sql)', () => {
  it('baseline establishes the watermark; an unchanged lastmod on the next check creates zero Changes; only a genuinely changed lastmod fires one updated Change; re-checking that value again is a no-op', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap',
      sourceUrl: 'https://example.com/sitemap-watermark.xml',
    });
    const fetchStubV1 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-watermark.xml': () =>
        new Response(SITEMAP_WITH_LASTMOD_BODY, { status: 200, headers: { 'content-type': 'application/xml' } }),
    });

    // call 1: baseline. Target 登録され watermark = 2026-01-01 が確定するが Change は0件。
    const first = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV1, hostLimiter: grantingLimiter() },
    );
    expect(first.changeIds).toHaveLength(0);

    const targetsAfterFirst = await listTargetsByMonitor(db(), monitor.id);
    const pageTargetAfterFirst = targetsAfterFirst.find((t) => t.url === 'https://example.com/dup-recovery-page');
    expect(pageTargetAfterFirst?.lastKnownUpdatedAt).toBe('2026-01-01T00:00:00.000Z');

    // call 2: 同一 lastmod (unchanged) の再チェック。修正前 (dedupeKey 存在有無だけで判定) は
    // ここで「初めて見る dedupeKey」として 'updated' Change が誤って発火していた
    // (baseline は Change を作らないため)。watermark 導入後は Target 側の値と比較するので
    // lastmod が変わっていない限り Change は生成されない。
    const secondSend = vi.fn();
    const second = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: secondSend } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV1, hostLimiter: grantingLimiter() },
    );
    expect(second.changeIds).toHaveLength(0);
    expect(secondSend).not.toHaveBeenCalled();
    expect(await listChangesByMonitor(db(), monitor.id)).toHaveLength(0);

    // call 3: lastmod が実際に変わった -> その1件だけ 'updated' Change として検出・通知される。
    const fetchStubV2 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-watermark.xml': () =>
        new Response(SITEMAP_WITH_LASTMOD_BODY_V2, { status: 200, headers: { 'content-type': 'application/xml' } }),
    });
    const thirdSend = vi.fn();
    const third = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: thirdSend } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV2, hostLimiter: grantingLimiter() },
    );
    expect(third.changeIds).toHaveLength(1);
    expect(thirdSend).toHaveBeenCalledTimes(1);

    const changesAfterThird = await listChangesByMonitor(db(), monitor.id);
    expect(changesAfterThird).toHaveLength(1);
    expect(changesAfterThird[0]!.kind).toBe('updated');

    const targetsAfterThird = await listTargetsByMonitor(db(), monitor.id);
    const pageTargetAfterThird = targetsAfterThird.find((t) => t.url === 'https://example.com/dup-recovery-page');
    expect(pageTargetAfterThird?.lastKnownUpdatedAt).toBe('2026-02-01T00:00:00.000Z');

    // call 4: 同じ (新しい) lastmod の再チェックは重複 Change/通知を作らない。
    const fourthSend = vi.fn();
    const fourth = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: fourthSend } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV2, hostLimiter: grantingLimiter() },
    );
    expect(fourth.changeIds).toHaveLength(0);
    expect(fourthSend).not.toHaveBeenCalled();
    expect(await listChangesByMonitor(db(), monitor.id)).toHaveLength(1);
  });
});

describe('processFeedItems: duplicate dedupeKey recovery (at-least-once delivery, SPEC §17.7-8)', () => {
  it('recreates delivery/notify for a duplicate updated-item Change when a prior run crashed after the Change commit but before the watermark advance', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap',
      sourceUrl: 'https://example.com/sitemap-dup.xml',
    });
    const fetchStubV1 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-dup.xml': () =>
        new Response(SITEMAP_WITH_LASTMOD_BODY, { status: 200, headers: { 'content-type': 'application/xml' } }),
    });

    // call 1: monitor の初回チェック (baseline) -> Target 登録 (watermark = 2026-01-01) のみ、Change 0件。
    const firstResult = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV1, hostLimiter: grantingLimiter() },
    );
    expect(firstResult.changeIds).toHaveLength(0);

    const targetsAfterFirst = await listTargetsByMonitor(db(), monitor.id);
    const pageTarget = targetsAfterFirst.find((t) => t.url === 'https://example.com/dup-recovery-page');
    expect(pageTarget).toBeTruthy();
    expect(pageTarget!.lastKnownUpdatedAt).toBe('2026-01-01T00:00:00.000Z');

    // Simulate a crash *inside* a prior run that already detected the lastmod change
    // (2026-01-01 -> 2026-02-01): it managed to insert the 'updated' Change row
    // (dedupeKey = `${url}:2026-02-01T00:00:00.000Z`) but crashed before creating the
    // Delivery and — crucially — before feed.ts's deferred setTargetLastKnownUpdatedAt call,
    // so the Target's watermark is still stuck at the old value (2026-01-01). This is
    // reproduced directly (rather than via an extra runMonitorCheck call) because, after this
    // fix, a *successful* run always advances the watermark together with the notify attempt —
    // so the only way to observe a "Change committed, watermark not advanced" state is a crash
    // strictly between those two steps.
    const preCrashChange = await insertChangeIfNew(db(), {
      monitorId: monitor.id,
      targetId: pageTarget!.id,
      targetUrl: pageTarget!.url,
      kind: 'updated',
      dedupeKey: `${pageTarget!.url}:2026-02-01T00:00:00.000Z`,
      detectedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(preCrashChange.inserted).toBe(true);
    expect(await listDeliveriesByChange(db(), preCrashChange.row.id)).toHaveLength(0);

    // call 2: the site now reports lastmod 2026-02-01 (matching the "crashed" attempt above).
    // Because the watermark is still 2026-01-01, this check must re-enter the 'updated'
    // detection branch, hit the (monitor_id, dedupe_key) conflict from the pre-existing
    // Change row (inserted:false), and still recover the Delivery/notify — then finally
    // advance the watermark to 2026-02-01.
    const fetchStubV2 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-dup.xml': () =>
        new Response(SITEMAP_WITH_LASTMOD_BODY_V2, { status: 200, headers: { 'content-type': 'application/xml' } }),
    });
    const secondSend = vi.fn();
    const secondResult = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: secondSend } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV2, hostLimiter: grantingLimiter() },
    );

    expect(secondResult.changeIds).toHaveLength(0); // duplicate (already existed), not newly detected this run
    expect(secondSend).toHaveBeenCalledTimes(1); // but delivery/notify still recovers

    const changesAfter = await listChangesByMonitor(db(), monitor.id);
    expect(changesAfter.filter((c) => c.kind === 'updated')).toHaveLength(1); // no duplicate row

    const deliveriesAfter = await listDeliveriesByChange(db(), preCrashChange.row.id);
    expect(deliveriesAfter).toHaveLength(1);

    const targetsAfterSecond = await listTargetsByMonitor(db(), monitor.id);
    const pageTargetAfterSecond = targetsAfterSecond.find((t) => t.url === 'https://example.com/dup-recovery-page');
    expect(pageTargetAfterSecond?.lastKnownUpdatedAt).toBe('2026-02-01T00:00:00.000Z');

    // call 3: unchanged lastmod (2026-02-01) again -> now that the watermark has caught up,
    // this is correctly a no-op (no additional Change/notify) — this is the behavior the
    // watermark fix exists to guarantee.
    const thirdSend = vi.fn();
    const thirdResult = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: thirdSend } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV2, hostLimiter: grantingLimiter() },
    );
    expect(thirdResult.changeIds).toHaveLength(0);
    expect(thirdSend).not.toHaveBeenCalled();
    expect(await listChangesByMonitor(db(), monitor.id)).toHaveLength(1);
  });
});

describe('runMonitorCheck: feed baseline (初回大量取り込み防止, incident: www.hira2.jp sitemap-index)', () => {
  it('creates zero Changes and zero notifications on the first check of a sitemap with many URLs, while registering every URL as a Target', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap',
      sourceUrl: 'https://example.com/big-sitemap.xml',
    });
    const urls = Array.from({ length: 25 }, (_, i) => `https://example.com/page-${i}`);
    const bigSitemapBody = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>`;
    const sendSpy = vi.fn();
    const fetchStub = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/big-sitemap.xml': () =>
        new Response(bigSitemapBody, { status: 200, headers: { 'content-type': 'application/xml' } }),
    });

    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: sendSpy } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );

    expect(result.kind).toBe('completed');
    expect(result.changeIds).toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();

    const targets = await listTargetsByMonitor(db(), monitor.id);
    // sitemap 文書自体の Target (1) + 25 item Target
    expect(targets).toHaveLength(26);
    expect(await listChangesByMonitor(db(), monitor.id)).toHaveLength(0);
  });
});

describe('processFeedItems: URL 処理上限 (MAX_FEED_ITEMS_PER_CHECK, silent truncation 禁止)', () => {
  it('exports a positive default cap', () => {
    expect(MAX_FEED_ITEMS_PER_CHECK).toBeGreaterThan(0);
  });

  it('processes only the first maxItems entries and logs the skipped count via console.warn', async () => {
    const { monitor, source, site } = await buildPipelineFixture({
      sourceType: 'sitemap',
      sourceUrl: 'https://example.com/injected-cap-sitemap.xml',
    });

    const items: FeedItem[] = Array.from({ length: 5 }, (_, i) => ({
      stableKey: `https://example.com/cap-page-${i}`,
      url: `https://example.com/cap-page-${i}`,
      title: null,
      publishedAt: null,
      updatedAt: null,
      summary: null,
    }));

    const ctx: CheckContext = {
      env: fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      db: db(),
      monitor,
      source,
      site,
      policy: {} as unknown as CheckContext['policy'],
      job: {} as unknown as CheckContext['job'],
      now: () => Date.now(),
      changeIds: [],
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 上限を意図的に 3 に注入 (5件中2件はスキップされ次回以降に持ち越される)
      await processFeedItems(ctx, items, 3);

      // mockRestore() は呼び出し履歴もクリアしてしまうため、assert は restore する前に行う。
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnMessage = warnSpy.mock.calls[0]![0] as string;
      expect(warnMessage).toContain('exceeds');
      expect(warnMessage).toContain('skipping 2');
    } finally {
      warnSpy.mockRestore();
    }

    const targets = await listTargetsByMonitor(db(), monitor.id);
    expect(targets).toHaveLength(3);
    expect(targets.map((t) => t.url).sort()).toEqual([
      'https://example.com/cap-page-0',
      'https://example.com/cap-page-1',
      'https://example.com/cap-page-2',
    ]);
  });
});
