/**
 * Sitemap 探索モード (ADR-0010 Phase B, docs/adr/0010-detection-chain-and-source-promotion.md)。
 * config.sitemapMode === 'traverse' の sitemap/sitemap-index Source が、既定の Sitemap Direct
 * (Phase A) ではなく src/pipeline/sitemapTraversal.ts の processSitemapTraversal に到達し、
 * lastmodが変化した子だけを再帰展開して実URLの新規出現・lastmod更新を配信することを検証する。
 */
import { describe, expect, it, vi } from 'vitest';
import { runMonitorCheck } from '../../src/pipeline/runCheck';
import { matchesChildIncludePattern, traverseSitemapIndex } from '../../src/pipeline/sitemapTraversal';
import type { CheckContext } from '../../src/pipeline/types';
import type { Env } from '../../src/shared/env';
import type { AdapterParseResult, FetcherPolicy } from '../../src/shared/contracts';
import {
  createCheckJobIfNew,
  getFetcherPolicy,
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

  it('does not re-fetch a child whose lastmod regressed below the watermark, and keeps the watermark monotonic', async () => {
    // lastmod が一時的に後退するサイト (キャッシュ揺れ等) で、単純な不一致判定だと再展開+
    // watermark巻き戻しを繰り返してしまう問題の回帰テスト (CodeRabbit round-3 指摘)。
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/traverse-root-regress.xml',
      sourceConfig: { sitemapMode: 'traverse' },
    });
    const rootBody = (lastmod: string) =>
      sitemapIndexBody([{ loc: 'https://example.com/child-regress.xml', lastmod }]);
    const routes = (lastmod: string) => ({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/traverse-root-regress.xml': () =>
        new Response(rootBody(lastmod), { status: 200, headers: { 'content-type': 'application/xml' } }),
      'https://example.com/child-regress.xml': () =>
        new Response(urlsetBody([{ loc: 'https://example.com/posts/r-1', lastmod: WITHIN_CUTOFF_B }]), {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        }),
    });

    // baseline: watermark = B で記録される。
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: routedFetch(routes(WITHIN_CUTOFF_B)), hostLimiter: grantingLimiter(), now: NOW },
    );

    // 2回目: lastmod が A (< B, cutoff内) に後退 → ゲートされフェッチされず、watermarkはBのまま。
    const { fetch: fetchStub, calls } = trackingFetch(routedFetch(routes(WITHIN_CUTOFF_A)));
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter(), now: NOW },
    );

    expect(calls.some((u) => u.includes('child-regress.xml'))).toBe(false);
    const targets = await listTargetsByMonitor(db(), monitor.id);
    const child = targets.find((t) => t.url === 'https://example.com/child-regress.xml');
    expect(child?.lastKnownUpdatedAt).toBe(WITHIN_CUTOFF_B);

    // 3回目: lastmod が C (> B) に前進 → 通常どおり展開され、watermark も C へ前進する。
    const { fetch: thirdFetch, calls: thirdCalls } = trackingFetch(routedFetch(routes(WITHIN_CUTOFF_C)));
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: thirdFetch, hostLimiter: grantingLimiter(), now: NOW },
    );
    expect(thirdCalls.some((u) => u.includes('child-regress.xml'))).toBe(true);
    const targetsAfterThird = await listTargetsByMonitor(db(), monitor.id);
    expect(targetsAfterThird.find((t) => t.url === 'https://example.com/child-regress.xml')?.lastKnownUpdatedAt).toBe(
      WITHIN_CUTOFF_C,
    );
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

  it('never fetches or registers a child sitemap without lastmod (baseline and after), and does not record an audit event for it', async () => {
    // lastmod の無い子は watermark ゲートが成立せず毎チェック無条件フェッチになってしまうため、
    // selectChildEntries で traversal 対象から除外される (CodeRabbit round-2 指摘の回帰テスト)。
    // 定常スキップ (missingLastmodSkipped) なので audit イベントも作られない。
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/traverse-root-nolastmod.xml',
      sourceConfig: { sitemapMode: 'traverse' },
    });
    const rootBody = (withLastmod: string) =>
      sitemapIndexBody([
        { loc: 'https://example.com/child-with-lastmod.xml', lastmod: withLastmod },
        { loc: 'https://example.com/child-no-lastmod.xml' }, // lastmod無し
      ]);
    const routes = (withLastmod: string) => ({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/traverse-root-nolastmod.xml': () =>
        new Response(rootBody(withLastmod), { status: 200, headers: { 'content-type': 'application/xml' } }),
      'https://example.com/child-with-lastmod.xml': () =>
        new Response(urlsetBody([{ loc: 'https://example.com/posts/w-1', lastmod: WITHIN_CUTOFF_B }]), {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        }),
      'https://example.com/child-no-lastmod.xml': () =>
        new Response(urlsetBody([{ loc: 'https://example.com/posts/n-1', lastmod: WITHIN_CUTOFF_B }]), {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        }),
    });

    // baseline + 2回目 (lastmod持ちの子だけ変化) の両方で、lastmod無しの子は一切フェッチされない。
    // あわせて、除外が missingLastmodSkipped としてカウントされ warn に出ることも検証する
    // (フェッチされない・登録されないだけの検証だとカウント/warn経路の破損に気づけないため)。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { fetch: baselineFetch, calls: baselineCalls } = trackingFetch(routedFetch(routes(WITHIN_CUTOFF_A)));
      await runMonitorCheck(
        fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
        monitor.id,
        { fetch: baselineFetch, hostLimiter: grantingLimiter(), now: NOW },
      );
      const { fetch: secondFetch, calls: secondCalls } = trackingFetch(routedFetch(routes(WITHIN_CUTOFF_B)));
      await runMonitorCheck(
        fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
        monitor.id,
        { fetch: secondFetch, hostLimiter: grantingLimiter(), now: NOW },
      );

      expect(baselineCalls.some((u) => u.includes('child-no-lastmod.xml'))).toBe(false);
      expect(secondCalls.some((u) => u.includes('child-no-lastmod.xml'))).toBe(false);
      // lastmod持ちの子は通常どおり2回目で展開される。
      expect(secondCalls.some((u) => u.includes('child-with-lastmod.xml'))).toBe(true);

      // 各チェックで missingLastmodSkipped: 1 が warn に記録される (mockRestore 前に検証すること)。
      const truncationWarns = warnSpy.mock.calls
        .map((args) => String(args[0]))
        .filter((m) => m.includes('truncated during traversal'));
      expect(truncationWarns).toHaveLength(2);
      for (const m of truncationWarns) {
        expect(m).toContain('"missingLastmodSkipped":1');
      }
    } finally {
      warnSpy.mockRestore();
    }

    // lastmod無しの子は Target 登録もされない (selectChildEntries で traverseChild 到達前に除外)。
    const targets = await listTargetsByMonitor(db(), monitor.id);
    expect(targets.some((t) => t.url === 'https://example.com/child-no-lastmod.xml')).toBe(false);
    expect(targets.some((t) => t.url === 'https://example.com/child-with-lastmod.xml')).toBe(true);

    // 定常スキップのみなので audit イベントは作られない (warnのみ)。
    const audits = await listAuditEventsBySubject(db(), monitor.id);
    expect(audits.filter((a) => a.action === 'monitor.traversal_truncated')).toHaveLength(0);
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

// CodeRabbit レビュー指摘 (PR #10) への対応: 子選択の cutoff 前倒し + lastmod 降順優先。
describe('runMonitorCheck: Sitemap Traversal MAX_CHILD_SITEMAPS selection is lastmod-priority, not document-order', () => {
  it('drops the single oldest child when 21 children are all within cutoff, and records childrenTruncated in the audit event', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/traverse-root-priority.xml',
      sourceConfig: { sitemapMode: 'traverse' },
    });
    // 21件、いずれも cutoff 内だが lastmod が1分刻みで異なる (安定して21件以上並ぶ状況を再現)。
    const baseTimeMs = new Date(WITHIN_CUTOFF_A).getTime();
    const children = Array.from({ length: 21 }, (_, i) => ({
      loc: `https://example.com/priority-child-${i}.xml`,
      lastmod: new Date(baseTimeMs + i * 60_000).toISOString(),
    }));
    const oldestChildUrl = children[0]!.loc; // lastmod が最も古い (=最初に切り捨てられるべき) 子

    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      {
        fetch: routedFetch({
          [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
          'https://example.com/traverse-root-priority.xml': () =>
            new Response(sitemapIndexBody(children), { status: 200, headers: { 'content-type': 'application/xml' } }),
        }),
        hostLimiter: grantingLimiter(),
        now: NOW,
      },
    );

    const targets = await listTargetsByMonitor(db(), monitor.id);
    // Source自体 (1) + 20件の子 (最古の1件は MAX_CHILD_SITEMAPS の枠から漏れる)。
    expect(targets).toHaveLength(21);
    expect(targets.some((t) => t.url === oldestChildUrl)).toBe(false);
    // 残り20件はすべて登録されている (念のため一部を確認)。
    expect(targets.some((t) => t.url === children[20]!.loc)).toBe(true);

    const events = await listAuditEventsBySubject(db(), monitor.id);
    const truncationEvent = events.find((e) => e.action === 'monitor.traversal_truncated');
    expect(truncationEvent).toBeTruthy();
    expect((truncationEvent?.payload as { childrenTruncated: number }).childrenTruncated).toBe(1);
  });
});

describe('runMonitorCheck: Sitemap Traversal nested truncation blocks the intermediate node watermark (batch1 regression)', () => {
  it('does not advance the watermark of an intermediate child sitemap-index when its own children get truncated, so it is re-fetched next check', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/nest-trunc-root.xml',
      sourceConfig: { sitemapMode: 'traverse' },
    });
    // C1 (中間ノード) 自身は21件の孫Sitemapを持つ -> 孫レベルで childrenTruncated が発生する。
    const grandchildren = Array.from({ length: 21 }, (_, i) => ({
      loc: `https://example.com/nest-trunc-grandchild-${i}.xml`,
      lastmod: WITHIN_CUTOFF_A,
    }));
    const rootBody = (c1Lastmod: string) =>
      sitemapIndexBody([{ loc: 'https://example.com/nest-trunc-c1.xml', lastmod: c1Lastmod }]);

    // run1: baseline. C1 registered (watermark = A), not fetched.
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      {
        fetch: routedFetch({
          [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
          'https://example.com/nest-trunc-root.xml': () =>
            new Response(rootBody(WITHIN_CUTOFF_A), { status: 200, headers: { 'content-type': 'application/xml' } }),
        }),
        hostLimiter: grantingLimiter(),
        now: NOW,
      },
    );

    // run2: C1's lastmod changes (A -> B) -> C1 fetched -> its 21 grandchildren trigger
    // childrenTruncated=1 at the grandchild level (21 > MAX_CHILD_SITEMAPS=20). Since this
    // truncation happened while expanding C1's own children, C1's watermark must NOT advance
    // (batch1 fix: propagation via truncationTotal(), not just childrenTruncated+depthTruncated).
    // Any grandchild fetch attempt without an explicit stub falls back to routedFetch's 404,
    // which traverseChild handles gracefully (outcome.ok === false -> skip, no crash).
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      {
        fetch: routedFetch({
          [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
          'https://example.com/nest-trunc-root.xml': () =>
            new Response(rootBody(WITHIN_CUTOFF_B), { status: 200, headers: { 'content-type': 'application/xml' } }),
          'https://example.com/nest-trunc-c1.xml': () =>
            new Response(sitemapIndexBody(grandchildren), {
              status: 200,
              headers: { 'content-type': 'application/xml' },
            }),
        }),
        hostLimiter: grantingLimiter(),
        now: NOW,
      },
    );

    const targetsAfterRun2 = await listTargetsByMonitor(db(), monitor.id);
    const c1AfterRun2 = targetsAfterRun2.find((t) => t.url === 'https://example.com/nest-trunc-c1.xml');
    // 核心: C1 は正常にフェッチ・パースできたが、孫レベルで打ち切りが起きたため watermark は
    // 前進していない (A のまま)。
    expect(c1AfterRun2?.lastKnownUpdatedAt).toBe(WITHIN_CUTOFF_A);

    const events = await listAuditEventsBySubject(db(), monitor.id);
    const truncationEvent = events.find((e) => e.action === 'monitor.traversal_truncated');
    expect(truncationEvent).toBeTruthy();
    expect((truncationEvent?.payload as { childrenTruncated: number }).childrenTruncated).toBe(1);

    // run3: root がC1のlastmodをBのまま (run2から変化なし) で報告しても、C1のwatermarkがまだA
    // (run2で進まなかった) のままなので A !== B でゲートされず、C1が再度フェッチされる
    // (孫の持ち越し分の処理機会が失われない = ADR-0010 §5「持ち越す」が守られる)。
    const { fetch: run3Fetch, calls: run3Calls } = trackingFetch(
      routedFetch({
        [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
        'https://example.com/nest-trunc-root.xml': () =>
          new Response(rootBody(WITHIN_CUTOFF_B), { status: 200, headers: { 'content-type': 'application/xml' } }),
        'https://example.com/nest-trunc-c1.xml': () =>
          new Response(sitemapIndexBody(grandchildren), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      }),
    );
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: run3Fetch, hostLimiter: grantingLimiter(), now: NOW },
    );
    expect(run3Calls.some((u) => u.includes('nest-trunc-c1.xml'))).toBe(true);
  });
});

describe('runMonitorCheck: Sitemap Traversal fetch budget (MAX_TRAVERSAL_FETCHES_PER_CHECK)', () => {
  it('stops fetching children once the injected fetch budget is exhausted, prioritized by lastmod, and does not advance the watermark of the budget-blocked child', async () => {
    const { monitor, site, source } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/fetch-budget-root.xml',
      sourceConfig: { sitemapMode: 'traverse' },
    });
    const maybePolicy = await getFetcherPolicy(db(), site.id);
    if (!maybePolicy) throw new Error('test setup: expected a fetcher policy to exist');
    const fetcherPolicy: FetcherPolicy = maybePolicy;

    const children = [
      { loc: 'https://example.com/budget-child-1.xml', oldLastmod: WITHIN_CUTOFF_A, newLastmod: WITHIN_CUTOFF_B },
      { loc: 'https://example.com/budget-child-2.xml', oldLastmod: WITHIN_CUTOFF_A, newLastmod: WITHIN_CUTOFF_C },
      {
        loc: 'https://example.com/budget-child-3.xml',
        oldLastmod: WITHIN_CUTOFF_A,
        newLastmod: '2026-07-10T18:00:00.000Z',
      },
    ];

    function buildParsedIndex(useNewLastmod: boolean): AdapterParseResult {
      return {
        kind: 'sitemap-index',
        items: children.map((c) => ({
          stableKey: c.loc,
          url: c.loc,
          title: null,
          publishedAt: null,
          updatedAt: useNewLastmod ? c.newLastmod : c.oldLastmod,
          summary: null,
        })),
        childSitemaps: children.map((c) => c.loc),
        meta: { title: null },
      };
    }

    const cutoffIso = new Date(NOW().getTime() - 3 * 86_400_000).toISOString();

    // check_attempts.check_job_id has a real FK to check_jobs(id) (migrations/0001_init.sql),
    // so traverseChild's fetchTargetThroughPolicy -> createCheckAttempt needs an actual row here
    // (unlike ctx.job in feed.test.ts's processFeedItems-only test, which never touches check_attempts).
    const { row: job } = await createCheckJobIfNew(db(), {
      monitorId: monitor.id,
      scheduledFor: NOW().toISOString(),
      trigger: 'manual',
    });

    function buildCtx(fetchImpl: typeof fetch, lastCheckedAt: string | null): CheckContext {
      return {
        env: fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
        db: db(),
        monitor: { ...monitor, lastCheckedAt },
        source,
        site,
        policy: fetcherPolicy,
        job,
        fetchImpl,
        now: () => NOW().getTime(),
        changeIds: [],
      };
    }

    // run1 (baseline): register the 3 children with their old watermark, no fetch attempted.
    const counts1 = {
      childrenTruncated: 0,
      depthTruncated: 0,
      originBlocked: 0,
      missingLastmodSkipped: 0,
      feedItemsTruncated: 0,
      fetchBudgetTruncated: 0,
      fetchesUsed: 0,
      patternExcluded: 0,
    };
    await traverseSitemapIndex(
      buildCtx(routedFetch({ [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1] }), null),
      buildParsedIndex(false),
      0,
      cutoffIso,
      3,
      counts1,
    );

    // run2 (non-baseline, injected maxFetchesPerCheck=2): all 3 children changed lastmod (so
    // none are watermark-gated), but only 2 may actually be fetched this check.
    const stub = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/budget-child-1.xml': () =>
        new Response(urlsetBody([]), { status: 200, headers: { 'content-type': 'application/xml' } }),
      'https://example.com/budget-child-2.xml': () =>
        new Response(urlsetBody([]), { status: 200, headers: { 'content-type': 'application/xml' } }),
      'https://example.com/budget-child-3.xml': () =>
        new Response(urlsetBody([]), { status: 200, headers: { 'content-type': 'application/xml' } }),
    });
    const { fetch: trackedFetch, calls } = trackingFetch(stub);
    const counts2 = {
      childrenTruncated: 0,
      depthTruncated: 0,
      originBlocked: 0,
      missingLastmodSkipped: 0,
      feedItemsTruncated: 0,
      fetchBudgetTruncated: 0,
      fetchesUsed: 0,
      patternExcluded: 0,
    };
    await traverseSitemapIndex(
      buildCtx(trackedFetch, '2026-07-01T00:00:00.000Z'),
      buildParsedIndex(true),
      0,
      cutoffIso,
      3,
      counts2,
      2, // maxFetchesPerCheck injected (mirrors processFeedItems's maxItems test pattern)
    );

    // budget-child-3 has the newest lastmod (2026-07-10T18:00:00) among the 3, so lastmod-descending
    // priority puts it first; budget-child-2 (07-10T12:00) second; budget-child-1 (07-10T00:00) last.
    // With a budget of 2, only the two newest are fetched.
    expect(calls.some((u) => u.includes('budget-child-3.xml'))).toBe(true);
    expect(calls.some((u) => u.includes('budget-child-2.xml'))).toBe(true);
    expect(calls.some((u) => u.includes('budget-child-1.xml'))).toBe(false);
    expect(counts2.fetchBudgetTruncated).toBe(1);
    expect(counts2.fetchesUsed).toBe(2);

    const targets = await listTargetsByMonitor(db(), monitor.id);
    const child1 = targets.find((t) => t.url === 'https://example.com/budget-child-1.xml');
    const child3 = targets.find((t) => t.url === 'https://example.com/budget-child-3.xml');
    // budget-child-1 was budget-blocked: its watermark stays at the old value.
    expect(child1?.lastKnownUpdatedAt).toBe(WITHIN_CUTOFF_A);
    // budget-child-3 was actually fetched+expanded (empty urlset, no further truncation): watermark advances.
    expect(child3?.lastKnownUpdatedAt).toBe('2026-07-10T18:00:00.000Z');
  });
});

// ADR-0015: child_include_patterns によるtraverse対象の子sitemap絞り込み。
describe('matchesChildIncludePattern (ADR-0015 glob matching)', () => {
  it('matches "*" against any suffix, including empty, on the filename only', () => {
    expect(matchesChildIncludePattern('https://example.com/post-sitemap.xml', ['post-sitemap*.xml'])).toBe(true);
    expect(matchesChildIncludePattern('https://example.com/post-sitemap2.xml', ['post-sitemap*.xml'])).toBe(true);
    expect(matchesChildIncludePattern('https://example.com/post-sitemap30.xml', ['post-sitemap*.xml'])).toBe(true);
  });

  it('does not match a filename that merely contains the literal prefix (anchored match)', () => {
    expect(matchesChildIncludePattern('https://example.com/post_tag-sitemap.xml', ['post-sitemap*.xml'])).toBe(false);
    expect(matchesChildIncludePattern('https://example.com/page-sitemap.xml', ['post-sitemap*.xml'])).toBe(false);
  });

  it('requires an exact match for a pattern without "*"', () => {
    expect(matchesChildIncludePattern('https://example.com/sitemap.xml', ['sitemap.xml'])).toBe(true);
    expect(matchesChildIncludePattern('https://example.com/sitemap2.xml', ['sitemap.xml'])).toBe(false);
  });

  it('treats regex metacharacters in the pattern as literal, not as regex syntax', () => {
    // '.' はワイルドカードではなくリテラルの '.' として扱われる (regex の任意1文字ではない)。
    expect(matchesChildIncludePattern('https://example.com/post-sitemapXxml', ['post-sitemap*.xml'])).toBe(false);
    expect(matchesChildIncludePattern('https://example.com/post-sitemap.xml', ['post-sitemap*.xml'])).toBe(true);
  });

  it('is case-sensitive', () => {
    expect(matchesChildIncludePattern('https://example.com/Post-Sitemap.xml', ['post-sitemap*.xml'])).toBe(false);
  });

  it('matches when any of multiple patterns matches', () => {
    const patterns = ['post-sitemap*.xml', 'news-sitemap*.xml'];
    expect(matchesChildIncludePattern('https://example.com/news-sitemap1.xml', patterns)).toBe(true);
    expect(matchesChildIncludePattern('https://example.com/post_tag-sitemap.xml', patterns)).toBe(false);
  });

  it('evaluates only the last path segment (filename), not the full URL', () => {
    // パス途中に 'post-sitemap' を含んでいてもファイル名自体が一致しなければマッチしない。
    expect(matchesChildIncludePattern('https://example.com/post-sitemap/archive.xml', ['post-sitemap*.xml'])).toBe(
      false,
    );
  });
});

describe('runMonitorCheck: Sitemap Traversal child_include_patterns (ADR-0015)', () => {
  it('excludes non-matching children from Target registration/selection without consuming the MAX_CHILD_SITEMAPS budget, and records patternExcluded alongside childrenTruncated in the audit event', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/pattern-root.xml',
      sourceConfig: { sitemapMode: 'traverse', childIncludePatterns: ['post-sitemap*.xml'] },
    });

    // 21件の記事sitemap (パターンにマッチ、cutoff内、lastmodをすべて異ならせる) + 3件のタグ
    // sitemap (パターンに非マッチ、cutoff内)。パターン除外がMAX_CHILD_SITEMAPSの枠取りより
    // *前段*で行われることを示すため、タグ側を混ぜても記事側の枠消費 (21件→20件への
    // truncate) が変わらないことを確認する。
    const baseTimeMs = new Date(WITHIN_CUTOFF_A).getTime();
    const postChildren = Array.from({ length: 21 }, (_, i) => ({
      loc: `https://example.com/post-sitemap-${i}.xml`,
      lastmod: new Date(baseTimeMs + i * 60_000).toISOString(),
    }));
    const tagChildren = Array.from({ length: 3 }, (_, i) => ({
      loc: `https://example.com/post_tag-sitemap-${i}.xml`,
      lastmod: WITHIN_CUTOFF_A,
    }));
    const oldestPostUrl = postChildren[0]!.loc; // 記事側で最も古い (=枠から漏れるべき) 子

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runMonitorCheck(
        fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
        monitor.id,
        {
          fetch: routedFetch({
            [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
            'https://example.com/pattern-root.xml': () =>
              new Response(sitemapIndexBody([...postChildren, ...tagChildren]), {
                status: 200,
                headers: { 'content-type': 'application/xml' },
              }),
          }),
          hostLimiter: grantingLimiter(),
          now: NOW,
        },
      );
    } finally {
      warnSpy.mockRestore();
    }

    const targets = await listTargetsByMonitor(db(), monitor.id);
    // Source自体 (1) + 記事側20件 (最古の1件はMAX_CHILD_SITEMAPSの枠から漏れる)。タグ側3件は
    // パターン非マッチのため Target すら作られない。
    expect(targets).toHaveLength(21);
    expect(targets.some((t) => t.url === oldestPostUrl)).toBe(false);
    expect(targets.some((t) => t.url === postChildren[20]!.loc)).toBe(true);
    for (const tag of tagChildren) {
      expect(targets.some((t) => t.url === tag.loc)).toBe(false);
    }

    const events = await listAuditEventsBySubject(db(), monitor.id);
    const truncationEvent = events.find((e) => e.action === 'monitor.traversal_truncated');
    expect(truncationEvent).toBeTruthy();
    const payload = truncationEvent?.payload as { childrenTruncated: number; patternExcluded: number };
    expect(payload.childrenTruncated).toBe(1);
    expect(payload.patternExcluded).toBe(3);
  });

  it('does not fetch or register non-matching children, and does not create an audit event when patternExcluded is the only non-zero count (routine filter, same treatment as originBlocked/missingLastmodSkipped)', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/pattern-only-root.xml',
      sourceConfig: { sitemapMode: 'traverse', childIncludePatterns: ['post-sitemap*.xml'] },
    });
    const rootBody = (postLastmod: string) =>
      sitemapIndexBody([
        { loc: 'https://example.com/post-sitemap.xml', lastmod: postLastmod },
        { loc: 'https://example.com/post_tag-sitemap.xml', lastmod: postLastmod },
      ]);

    // baseline
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      {
        fetch: routedFetch({
          [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
          'https://example.com/pattern-only-root.xml': () =>
            new Response(rootBody(WITHIN_CUTOFF_A), { status: 200, headers: { 'content-type': 'application/xml' } }),
        }),
        hostLimiter: grantingLimiter(),
        now: NOW,
      },
    );

    // 2回目: post-sitemap.xml のlastmodが変化 -> フェッチされる。post_tag-sitemap.xml は
    // パターン非マッチのため常に除外される (lastmodが変化しても対象外)。
    const { fetch: fetchStub, calls } = trackingFetch(
      routedFetch({
        [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
        'https://example.com/pattern-only-root.xml': () =>
          new Response(rootBody(WITHIN_CUTOFF_B), { status: 200, headers: { 'content-type': 'application/xml' } }),
        'https://example.com/post-sitemap.xml': () =>
          new Response(urlsetBody([]), { status: 200, headers: { 'content-type': 'application/xml' } }),
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runMonitorCheck(
        fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
        monitor.id,
        { fetch: fetchStub, hostLimiter: grantingLimiter(), now: NOW },
      );

      expect(calls.some((u) => u.includes('post-sitemap.xml') && !u.includes('post_tag'))).toBe(true);
      expect(calls.some((u) => u.includes('post_tag-sitemap.xml'))).toBe(false);

      const truncationWarns = warnSpy.mock.calls
        .map((args) => String(args[0]))
        .filter((m) => m.includes('truncated during traversal'));
      expect(truncationWarns.some((m) => m.includes('"patternExcluded":1'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }

    const targets = await listTargetsByMonitor(db(), monitor.id);
    expect(targets.some((t) => t.url === 'https://example.com/post-sitemap.xml')).toBe(true);
    expect(targets.some((t) => t.url === 'https://example.com/post_tag-sitemap.xml')).toBe(false);

    const events = await listAuditEventsBySubject(db(), monitor.id);
    expect(events.find((e) => e.action === 'monitor.traversal_truncated')).toBeUndefined();
  });

  it('leaves traversal behavior unchanged when child_include_patterns is not set (regression)', async () => {
    // 既存の「MAX_CHILD_SITEMAPS selection」テストと同一シナリオをパターン未設定で再確認する
    // (config.childIncludePatterns が undefined のときに従来どおり全子sitemapが対象になること)。
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/no-pattern-root.xml',
      sourceConfig: { sitemapMode: 'traverse' },
    });
    const rootBody = sitemapIndexBody([
      { loc: 'https://example.com/post-sitemap.xml', lastmod: WITHIN_CUTOFF_A },
      { loc: 'https://example.com/post_tag-sitemap.xml', lastmod: WITHIN_CUTOFF_A },
    ]);

    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      {
        fetch: routedFetch({
          [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
          'https://example.com/no-pattern-root.xml': () =>
            new Response(rootBody, { status: 200, headers: { 'content-type': 'application/xml' } }),
        }),
        hostLimiter: grantingLimiter(),
        now: NOW,
      },
    );

    const targets = await listTargetsByMonitor(db(), monitor.id);
    // パターン未設定なので両方とも登録される (従来どおり)。
    expect(targets.some((t) => t.url === 'https://example.com/post-sitemap.xml')).toBe(true);
    expect(targets.some((t) => t.url === 'https://example.com/post_tag-sitemap.xml')).toBe(true);
  });
});
