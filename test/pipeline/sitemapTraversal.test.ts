/**
 * Sitemap 探索モード (ADR-0010 Phase B, docs/adr/0010-detection-chain-and-source-promotion.md)。
 * config.sitemapMode === 'traverse' の sitemap/sitemap-index Source が、既定の Sitemap Direct
 * (Phase A) ではなく src/pipeline/sitemapTraversal.ts の processSitemapTraversal に到達し、
 * lastmodが変化した子だけを再帰展開して実URLの新規出現・lastmod更新を配信することを検証する。
 */
import { describe, expect, it, vi } from 'vitest';
import { runMonitorCheck } from '../../src/pipeline/runCheck';
import type { Env } from '../../src/shared/env';
import {
  listAuditEventsBySubject,
  listChangesByMonitor,
  listDeliveriesByChange,
  listTargetsByMonitor,
} from '../../src/db';
import { buildPipelineFixture, db, fakeEnv, grantingLimiter, routedFetch } from './helpers';

const NOW = () => new Date('2026-07-11T00:00:00.000Z');
// 既定 lastmodMaxAgeDays=3 のもとでの cutoff (now - 3日) = 2026-07-08T00:00:00.000Z
const WITHIN_CUTOFF_A = '2026-07-09T00:00:00.000Z';
const WITHIN_CUTOFF_B = '2026-07-10T00:00:00.000Z';
const WITHIN_CUTOFF_C = '2026-07-10T12:00:00.000Z';
const OUTSIDE_CUTOFF = '2026-06-01T00:00:00.000Z';

function sitemapIndexBody(entries: Array<{ loc: string; lastmod?: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((e) => `  <sitemap><loc>${e.loc}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}</sitemap>`).join('\n')}
</sitemapindex>`;
}

function urlsetBody(entries: Array<{ loc: string; lastmod?: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((e) => `  <url><loc>${e.loc}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}</url>`).join('\n')}
</urlset>`;
}

/** 呼び出された URL 一覧を記録しつつ元の stub へ委譲する fetch ラッパー (「フェッチされない」ことの検証用) */
function trackingFetch(stub: typeof fetch): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return stub(input, init);
  }) as typeof fetch;
  return { fetch: wrapped, calls };
}

const ROBOTS_ALLOW: [string, () => Response] = [
  'https://example.com/robots.txt',
  () => new Response('User-agent: *\nAllow: /', { status: 200 }),
];

describe('runMonitorCheck: Sitemap Traversal (sitemap-index) baseline', () => {
  it('registers child Targets with their lastmod watermark, does not fetch any child sitemap, and creates zero Changes', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/traverse-root-baseline.xml',
      sourceConfig: { sitemapMode: 'traverse' },
    });
    const stub = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/traverse-root-baseline.xml': () =>
        new Response(
          sitemapIndexBody([
            { loc: 'https://example.com/child-a.xml', lastmod: WITHIN_CUTOFF_A },
            { loc: 'https://example.com/child-b.xml', lastmod: WITHIN_CUTOFF_B },
          ]),
          { status: 200, headers: { 'content-type': 'application/xml' } },
        ),
    });
    const { fetch: fetchStub, calls } = trackingFetch(stub);
    const sendSpy = vi.fn();

    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: sendSpy } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter(), now: NOW },
    );

    expect(result.kind).toBe('completed');
    expect(result.changeIds).toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();

    const targets = await listTargetsByMonitor(db(), monitor.id);
    // Source自体 (root sitemap-index) + child-a + child-b の3件。実URLはまだ発見されていない。
    expect(targets).toHaveLength(3);
    const childA = targets.find((t) => t.url === 'https://example.com/child-a.xml');
    const childB = targets.find((t) => t.url === 'https://example.com/child-b.xml');
    expect(childA?.lastKnownUpdatedAt).toBe(WITHIN_CUTOFF_A);
    expect(childB?.lastKnownUpdatedAt).toBe(WITHIN_CUTOFF_B);

    expect(calls.some((u) => u.includes('child-a.xml'))).toBe(false);
    expect(calls.some((u) => u.includes('child-b.xml'))).toBe(false);
    expect(await listChangesByMonitor(db(), monitor.id)).toHaveLength(0);
  });
});

describe('runMonitorCheck: Sitemap Traversal incremental child expansion', () => {
  it('fetches only the child whose lastmod changed, expands its urlset, and delivers a new real URL; the unchanged child is not fetched', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/traverse-root-inc.xml',
      sourceConfig: { sitemapMode: 'traverse' },
    });

    const baselineStub = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/traverse-root-inc.xml': () =>
        new Response(
          sitemapIndexBody([
            { loc: 'https://example.com/child-a2.xml', lastmod: WITHIN_CUTOFF_A },
            { loc: 'https://example.com/child-b2.xml', lastmod: WITHIN_CUTOFF_A },
          ]),
          { status: 200, headers: { 'content-type': 'application/xml' } },
        ),
    });
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: baselineStub, hostLimiter: grantingLimiter(), now: NOW },
    );

    // 2回目: child-a2 の lastmod だけ変化 (child-b2 は不変)。child-a2 の urlset に新規URLが1件。
    const secondStub = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/traverse-root-inc.xml': () =>
        new Response(
          sitemapIndexBody([
            { loc: 'https://example.com/child-a2.xml', lastmod: WITHIN_CUTOFF_B },
            { loc: 'https://example.com/child-b2.xml', lastmod: WITHIN_CUTOFF_A },
          ]),
          { status: 200, headers: { 'content-type': 'application/xml' } },
        ),
      'https://example.com/child-a2.xml': () =>
        new Response(urlsetBody([{ loc: 'https://example.com/posts/new-1', lastmod: WITHIN_CUTOFF_B }]), {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        }),
    });
    const { fetch: fetchStub, calls } = trackingFetch(secondStub);
    const sendSpy = vi.fn();
    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: sendSpy } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter(), now: NOW },
    );

    expect(result.kind).toBe('completed');
    expect(calls.some((u) => u.includes('child-a2.xml'))).toBe(true);
    expect(calls.some((u) => u.includes('child-b2.xml'))).toBe(false);

    expect(result.changeIds).toHaveLength(1);
    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('new');
    expect(changes[0]?.targetUrl).toBe('https://example.com/posts/new-1');

    const deliveries = await listDeliveriesByChange(db(), changes[0]!.id);
    expect(deliveries).toHaveLength(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    const targets = await listTargetsByMonitor(db(), monitor.id);
    const childA2 = targets.find((t) => t.url === 'https://example.com/child-a2.xml');
    expect(childA2?.lastKnownUpdatedAt).toBe(WITHIN_CUTOFF_B);
  });
});

describe('runMonitorCheck: Sitemap Traversal does not advance a child watermark when processFeedItems truncates (ADR-0010 §5 regression)', () => {
  it('leaves the child watermark at its old value when its urlset exceeds MAX_FEED_ITEMS_PER_CHECK, so the child is re-fetched (not permanently gated) on a subsequent check', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/traverse-root-trunc.xml',
      sourceConfig: { sitemapMode: 'traverse' },
    });
    const rootBody = (childLastmod: string) =>
      sitemapIndexBody([{ loc: 'https://example.com/child-trunc.xml', lastmod: childLastmod }]);
    // MAX_FEED_ITEMS_PER_CHECK (既定 2000) を超える件数の urlset を返す (打ち切りを発生させる)。
    const bigUrlset = urlsetBody(
      Array.from({ length: 2001 }, (_, i) => ({
        loc: `https://example.com/posts/big-${i}`,
        lastmod: WITHIN_CUTOFF_B,
      })),
    );

    // run1: baseline. child registered (watermark = A), not fetched.
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      {
        fetch: routedFetch({
          [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
          'https://example.com/traverse-root-trunc.xml': () =>
            new Response(rootBody(WITHIN_CUTOFF_A), { status: 200, headers: { 'content-type': 'application/xml' } }),
        }),
        hostLimiter: grantingLimiter(),
        now: NOW,
      },
    );

    // run2: child lastmod changes (A -> B) -> fetched -> urlset has 2001 items, 1 gets truncated.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const run2Result = await runMonitorCheck(
        fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
        monitor.id,
        {
          fetch: routedFetch({
            [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
            'https://example.com/traverse-root-trunc.xml': () =>
              new Response(rootBody(WITHIN_CUTOFF_B), { status: 200, headers: { 'content-type': 'application/xml' } }),
            'https://example.com/child-trunc.xml': () =>
              new Response(bigUrlset, { status: 200, headers: { 'content-type': 'application/xml' } }),
          }),
          hostLimiter: grantingLimiter(),
          now: NOW,
        },
      );
      expect(run2Result.kind).toBe('completed');
      // 打ち切りが発生した (processFeedItems 側の console.warn 経由) ことを確認する。
      // mockRestore() は呼び出し履歴もクリアしてしまうため、assert は restore する前に行う
      // (feed.test.ts の「URL処理上限」テストと同じ注意点)。
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }

    // 核心: 打ち切りが起きた子の watermark は新しい lastmod (B) へは前進していない
    // (前進させてしまうと、次回チェックで子のlastmodがwatermarkと一致してゲートされ、
    // 持ち越し分が子のlastmodが次に変わるまで永久に処理されなくなる -- レビュー指摘の再発防止)。
    const targetsAfterRun2 = await listTargetsByMonitor(db(), monitor.id);
    const childAfterRun2 = targetsAfterRun2.find((t) => t.url === 'https://example.com/child-trunc.xml');
    expect(childAfterRun2?.lastKnownUpdatedAt).toBe(WITHIN_CUTOFF_A);

    // audit_events には feedItemsTruncated (>0) を含む monitor.traversal_truncated が記録される
    // (実際の作業打ち切りのため、originBlocked/missingLastmodSkipped単独とは異なり記録対象)。
    const events = await listAuditEventsBySubject(db(), monitor.id);
    const truncationEvent = events.find((e) => e.action === 'monitor.traversal_truncated');
    expect(truncationEvent).toBeTruthy();
    expect((truncationEvent?.payload as { feedItemsTruncated: number }).feedItemsTruncated).toBe(1);

    // run3: 子のlastmodはBのまま (run2から変化なし) だが、watermarkがまだA (run2で進まなかった) の
    // ままなので、A !== B でゲートされずに再度フェッチされる (持ち越し分の処理機会が失われない)。
    const { fetch: run3Fetch, calls: run3Calls } = trackingFetch(
      routedFetch({
        [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
        'https://example.com/traverse-root-trunc.xml': () =>
          new Response(rootBody(WITHIN_CUTOFF_B), { status: 200, headers: { 'content-type': 'application/xml' } }),
        'https://example.com/child-trunc.xml': () =>
          new Response(bigUrlset, { status: 200, headers: { 'content-type': 'application/xml' } }),
      }),
    );
    const warnSpy3 = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runMonitorCheck(
        fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
        monitor.id,
        { fetch: run3Fetch, hostLimiter: grantingLimiter(), now: NOW },
      );
    } finally {
      warnSpy3.mockRestore();
    }
    expect(run3Calls.some((u) => u.includes('child-trunc.xml'))).toBe(true);
  }, 20_000); // 2001件のurlsetをprocessFeedItemsに2回通すため既定の5秒テストタイムアウトでは不足する
});

describe('runMonitorCheck: Sitemap Traversal real-URL lastmod update detection', () => {
  it('detects a lastmod change on an already-discovered real URL as an "updated" Change', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/traverse-root-upd.xml',
      sourceConfig: { sitemapMode: 'traverse' },
    });
    const rootBody = (childLastmod: string) =>
      sitemapIndexBody([{ loc: 'https://example.com/child-upd.xml', lastmod: childLastmod }]);

    // run1: baseline. child registered, not fetched.
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      {
        fetch: routedFetch({
          [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
          'https://example.com/traverse-root-upd.xml': () =>
            new Response(rootBody(WITHIN_CUTOFF_A), { status: 200, headers: { 'content-type': 'application/xml' } }),
        }),
        hostLimiter: grantingLimiter(),
        now: NOW,
      },
    );

    // run2: child lastmod changes -> fetched -> real URL X (lastmod L1) discovered as 'new'.
    const run2 = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      {
        fetch: routedFetch({
          [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
          'https://example.com/traverse-root-upd.xml': () =>
            new Response(rootBody(WITHIN_CUTOFF_B), { status: 200, headers: { 'content-type': 'application/xml' } }),
          'https://example.com/child-upd.xml': () =>
            new Response(urlsetBody([{ loc: 'https://example.com/posts/x', lastmod: WITHIN_CUTOFF_B }]), {
              status: 200,
              headers: { 'content-type': 'application/xml' },
            }),
        }),
        hostLimiter: grantingLimiter(),
        now: NOW,
      },
    );
    expect(run2.changeIds).toHaveLength(1);
    const changesAfterRun2 = await listChangesByMonitor(db(), monitor.id);
    expect(changesAfterRun2.find((c) => c.targetUrl === 'https://example.com/posts/x')?.kind).toBe('new');

    // run3: child lastmod changes again -> fetched -> real URL X now has a newer lastmod -> 'updated'.
    const sendSpy = vi.fn();
    const run3 = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: sendSpy } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      {
        fetch: routedFetch({
          [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
          'https://example.com/traverse-root-upd.xml': () =>
            new Response(rootBody(WITHIN_CUTOFF_C), { status: 200, headers: { 'content-type': 'application/xml' } }),
          'https://example.com/child-upd.xml': () =>
            new Response(urlsetBody([{ loc: 'https://example.com/posts/x', lastmod: WITHIN_CUTOFF_C }]), {
              status: 200,
              headers: { 'content-type': 'application/xml' },
            }),
        }),
        hostLimiter: grantingLimiter(),
        now: NOW,
      },
    );
    expect(run3.changeIds).toHaveLength(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const changesAfterRun3 = await listChangesByMonitor(db(), monitor.id);
    const updatedChange = changesAfterRun3.find(
      (c) => c.targetUrl === 'https://example.com/posts/x' && c.kind === 'updated',
    );
    expect(updatedChange).toBeTruthy();
  });
});

describe('runMonitorCheck: Sitemap Traversal lastmod cutoff', () => {
  it('does not create a Change for a real URL older than the cutoff, nor for one with a null updatedAt', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/traverse-root-cutoff.xml',
      sourceConfig: { sitemapMode: 'traverse' },
    });
    const rootBody = (childLastmod: string) =>
      sitemapIndexBody([{ loc: 'https://example.com/child-cutoff.xml', lastmod: childLastmod }]);

    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      {
        fetch: routedFetch({
          [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
          'https://example.com/traverse-root-cutoff.xml': () =>
            new Response(rootBody(WITHIN_CUTOFF_A), { status: 200, headers: { 'content-type': 'application/xml' } }),
        }),
        hostLimiter: grantingLimiter(),
        now: NOW,
      },
    );

    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      {
        fetch: routedFetch({
          [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
          'https://example.com/traverse-root-cutoff.xml': () =>
            new Response(rootBody(WITHIN_CUTOFF_B), { status: 200, headers: { 'content-type': 'application/xml' } }),
          'https://example.com/child-cutoff.xml': () =>
            new Response(
              urlsetBody([
                { loc: 'https://example.com/posts/too-old', lastmod: OUTSIDE_CUTOFF },
                { loc: 'https://example.com/posts/no-lastmod' }, // lastmod無し (updatedAt=null)
              ]),
              { status: 200, headers: { 'content-type': 'application/xml' } },
            ),
        }),
        hostLimiter: grantingLimiter(),
        now: NOW,
      },
    );

    expect(result.changeIds).toHaveLength(0);
    expect(await listChangesByMonitor(db(), monitor.id)).toHaveLength(0);

    // 足切りされた実URLはTarget自体も作られない (processFeedItemsに渡る前にフィルタされるため)。
    const targets = await listTargetsByMonitor(db(), monitor.id);
    expect(targets.some((t) => t.url === 'https://example.com/posts/too-old')).toBe(false);
    expect(targets.some((t) => t.url === 'https://example.com/posts/no-lastmod')).toBe(false);
  });
});

describe('runMonitorCheck: Sitemap Traversal nested sitemap-index depth truncation', () => {
  it('stops recursing once the default max depth is reached and records monitor.traversal_truncated in audit_events', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/nest-root.xml',
      sourceConfig: { sitemapMode: 'traverse' },
    });

    // run1: baseline. root's only child (nest-c1, itself a sitemap-index) is registered but not fetched.
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      {
        fetch: routedFetch({
          [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
          'https://example.com/nest-root.xml': () =>
            new Response(sitemapIndexBody([{ loc: 'https://example.com/nest-c1.xml', lastmod: WITHIN_CUTOFF_A }]), {
              status: 200,
              headers: { 'content-type': 'application/xml' },
            }),
        }),
        hostLimiter: grantingLimiter(),
        now: NOW,
      },
    );

    // run2: nest-c1's lastmod changes -> fetched (depth1) -> its child nest-c2 (new, always expanded
    // even though this is the first time we see it, because the *monitor* is no longer in baseline) ->
    // fetched (depth2) -> its child nest-c3 (new) -> fetched (depth3, itself a sitemap-index) -> since
    // defaultMaxDepth=3 and depth+1(=3) is not < 3, recursion into nest-c3's own children is truncated.
    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      {
        fetch: routedFetch({
          [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
          'https://example.com/nest-root.xml': () =>
            new Response(sitemapIndexBody([{ loc: 'https://example.com/nest-c1.xml', lastmod: WITHIN_CUTOFF_B }]), {
              status: 200,
              headers: { 'content-type': 'application/xml' },
            }),
          'https://example.com/nest-c1.xml': () =>
            new Response(sitemapIndexBody([{ loc: 'https://example.com/nest-c2.xml', lastmod: WITHIN_CUTOFF_A }]), {
              status: 200,
              headers: { 'content-type': 'application/xml' },
            }),
          'https://example.com/nest-c2.xml': () =>
            new Response(sitemapIndexBody([{ loc: 'https://example.com/nest-c3.xml', lastmod: WITHIN_CUTOFF_A }]), {
              status: 200,
              headers: { 'content-type': 'application/xml' },
            }),
          'https://example.com/nest-c3.xml': () =>
            new Response(
              sitemapIndexBody([{ loc: 'https://example.com/nest-c4-never-fetched.xml', lastmod: WITHIN_CUTOFF_A }]),
              { status: 200, headers: { 'content-type': 'application/xml' } },
            ),
        }),
        hostLimiter: grantingLimiter(),
        now: NOW,
      },
    );

    expect(result.kind).toBe('completed');

    const targets = await listTargetsByMonitor(db(), monitor.id);
    // nest-c3 の子 (nest-c4) は深さ上限のため展開されず、Targetも作られない。
    expect(targets.some((t) => t.url === 'https://example.com/nest-c4-never-fetched.xml')).toBe(false);
    expect(targets.some((t) => t.url === 'https://example.com/nest-c3.xml')).toBe(true);

    const events = await listAuditEventsBySubject(db(), monitor.id);
    const truncationEvent = events.find((e) => e.action === 'monitor.traversal_truncated');
    expect(truncationEvent).toBeTruthy();
    expect(truncationEvent?.actor).toBe('system');
    expect((truncationEvent?.payload as { depthTruncated: number }).depthTruncated).toBe(1);
  });
});

describe('runMonitorCheck: Sitemap Traversal origin boundary', () => {
  it('does not fetch a child sitemap whose origin differs from the Site primaryOrigin; logs a warning but does not record an audit event (originBlocked alone is a routine, potentially every-check occurrence, not a work truncation)', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/origin-root.xml',
      sourceConfig: { sitemapMode: 'traverse' },
      primaryOrigin: 'https://example.com',
    });
    const stub = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/origin-root.xml': () =>
        new Response(
          sitemapIndexBody([
            { loc: 'https://example.com/same-origin-child.xml', lastmod: WITHIN_CUTOFF_A },
            { loc: 'https://evil.example/cross-origin-child.xml', lastmod: WITHIN_CUTOFF_A },
          ]),
          { status: 200, headers: { 'content-type': 'application/xml' } },
        ),
    });
    const { fetch: fetchStub, calls } = trackingFetch(stub);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runMonitorCheck(
        fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
        monitor.id,
        { fetch: fetchStub, hostLimiter: grantingLimiter(), now: NOW },
      );
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }

    expect(calls.some((u) => u.includes('cross-origin-child.xml'))).toBe(false);

    const targets = await listTargetsByMonitor(db(), monitor.id);
    expect(targets.some((t) => t.url === 'https://example.com/same-origin-child.xml')).toBe(true);
    expect(targets.some((t) => t.url === 'https://evil.example/cross-origin-child.xml')).toBe(false);

    // originBlocked のみ (実際の作業打ち切りではない、境界外の子を毎回除外する通常動作) なので
    // audit_events には記録されない (レビュー指摘: audit行のスパム防止)。
    const events = await listAuditEventsBySubject(db(), monitor.id);
    expect(events.find((e) => e.action === 'monitor.traversal_truncated')).toBeUndefined();
  });
});

describe('runMonitorCheck: Sitemap Traversal on a urlset Source directly', () => {
  it('baselines with cutoff filtering, then detects a newly-added in-cutoff URL as a "new" Change', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap',
      sourceUrl: 'https://example.com/traverse-urlset.xml',
      sourceConfig: { sitemapMode: 'traverse' },
    });

    const first = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      {
        fetch: routedFetch({
          [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
          'https://example.com/traverse-urlset.xml': () =>
            new Response(
              urlsetBody([
                { loc: 'https://example.com/posts/a', lastmod: WITHIN_CUTOFF_A },
                { loc: 'https://example.com/posts/stale', lastmod: OUTSIDE_CUTOFF },
              ]),
              { status: 200, headers: { 'content-type': 'application/xml' } },
            ),
        }),
        hostLimiter: grantingLimiter(),
        now: NOW,
      },
    );
    expect(first.changeIds).toHaveLength(0);
    const targetsAfterFirst = await listTargetsByMonitor(db(), monitor.id);
    // Source自体 + posts/a (cutoff内)。posts/stale は足切りされ Target すら作られない。
    expect(targetsAfterFirst).toHaveLength(2);
    expect(targetsAfterFirst.some((t) => t.url === 'https://example.com/posts/stale')).toBe(false);

    const sendSpy = vi.fn();
    const second = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: sendSpy } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      {
        fetch: routedFetch({
          [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
          'https://example.com/traverse-urlset.xml': () =>
            new Response(
              urlsetBody([
                { loc: 'https://example.com/posts/a', lastmod: WITHIN_CUTOFF_A },
                { loc: 'https://example.com/posts/b', lastmod: WITHIN_CUTOFF_B },
                { loc: 'https://example.com/posts/stale', lastmod: OUTSIDE_CUTOFF },
              ]),
              { status: 200, headers: { 'content-type': 'application/xml' } },
            ),
        }),
        hostLimiter: grantingLimiter(),
        now: NOW,
      },
    );

    expect(second.changeIds).toHaveLength(1);
    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('new');
    expect(changes[0]?.targetUrl).toBe('https://example.com/posts/b');
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

describe('runMonitorCheck: sitemap-index with an explicit direct config still uses processSitemapDirect', () => {
  it('does not fetch child sitemaps and does not create per-child Targets (Direct semantics, ADR-0010 Phase A)', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/explicit-direct.xml',
      sourceConfig: { sitemapMode: 'direct' },
    });
    const stub = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/explicit-direct.xml': () =>
        new Response(sitemapIndexBody([{ loc: 'https://example.com/direct-child.xml', lastmod: WITHIN_CUTOFF_A }]), {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        }),
    });
    const { fetch: fetchStub, calls } = trackingFetch(stub);

    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter(), now: NOW },
    );

    expect(result.kind).toBe('completed');
    expect(calls.some((u) => u.includes('direct-child.xml'))).toBe(false);

    // Direct モードは個々のURLをTarget化しない: Source自体の1件のみ。
    const targets = await listTargetsByMonitor(db(), monitor.id);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.url).toBe('https://example.com/explicit-direct.xml');
  });
});
