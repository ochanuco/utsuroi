/**
 * Enrich段 (ADR-0016): kind='new' かつ title が無い Change に対して targetUrl を軽量フェッチし
 * `<title>` を Change.title へ書き戻すことを検証する。
 */
import { describe, expect, it, vi } from 'vitest';
import { enrichDetectedChanges, MAX_TITLE_FETCHES_PER_CHECK } from '../../src/pipeline/enrichTitle';
import type { DetectedChange } from '../../src/pipeline/notify';
import type { CheckContext } from '../../src/pipeline/types';
import type { Env } from '../../src/shared/env';
import type { FetcherPolicy } from '../../src/shared/contracts';
import { getChange, getFetcherPolicy, insertChangeIfNew } from '../../src/db';
import { buildPipelineFixture, db, fakeEnv, routedFetch } from './helpers';

const NOW = () => new Date('2026-07-11T00:00:00.000Z');

const ROBOTS_ALLOW: [string, () => Response] = [
  'https://example.com/robots.txt',
  () => new Response('User-agent: *\nAllow: /', { status: 200 }),
];

async function setup() {
  const { monitor, site, source } = await buildPipelineFixture({
    sourceType: 'sitemap',
    sourceUrl: 'https://example.com/feed.xml',
  });
  const maybePolicy = await getFetcherPolicy(db(), site.id);
  if (!maybePolicy) throw new Error('test setup: expected a fetcher policy to exist');
  const fetcherPolicy: FetcherPolicy = maybePolicy;
  return { monitor, site, source, fetcherPolicy };
}

function buildCtx(
  monitor: Awaited<ReturnType<typeof setup>>['monitor'],
  source: Awaited<ReturnType<typeof setup>>['source'],
  site: Awaited<ReturnType<typeof setup>>['site'],
  fetcherPolicy: FetcherPolicy,
  fetchImpl: typeof fetch,
): CheckContext {
  return {
    env: fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
    db: db(),
    monitor,
    source,
    site,
    policy: fetcherPolicy,
    job: {} as unknown as CheckContext['job'],
    fetchImpl,
    now: () => NOW().getTime(),
    changeIds: [],
  };
}

async function makeDetected(
  monitorId: string,
  overrides: Partial<Parameters<typeof insertChangeIfNew>[1]> = {},
  inserted = true,
): Promise<DetectedChange> {
  const result = await insertChangeIfNew(db(), {
    monitorId,
    targetUrl: 'https://example.com/article-1',
    kind: 'new',
    dedupeKey: `dedupe-${Math.random()}`,
    title: null,
    ...overrides,
  });
  return { row: result.row, inserted };
}

describe('enrichDetectedChanges: target filtering', () => {
  it('skips kind=updated, changes that already have a title, and inserted=false', async () => {
    const { monitor, source, site, fetcherPolicy } = await setup();
    let fetchCalled = false;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalled = true;
      return routedFetch({})(input, init);
    }) as typeof fetch;

    const updated = await makeDetected(monitor.id, { kind: 'updated', targetUrl: 'https://example.com/updated' });
    const alreadyTitled = await makeDetected(monitor.id, {
      title: 'Already Has Title',
      targetUrl: 'https://example.com/titled',
    });
    const notInserted = await makeDetected(monitor.id, { targetUrl: 'https://example.com/not-inserted' }, false);

    const ctx = buildCtx(monitor, source, site, fetcherPolicy, fetchImpl);
    await enrichDetectedChanges(ctx, [updated, alreadyTitled, notInserted]);

    expect(fetchCalled).toBe(false);
    expect(updated.row.title).toBeNull();
    expect(alreadyTitled.row.title).toBe('Already Has Title');
    expect(notInserted.row.title).toBeNull();
  });
});

describe('enrichDetectedChanges: successful enrich', () => {
  it('fetches the title and writes it to both the DB row and the in-memory DetectedChange', async () => {
    const { monitor, source, site, fetcherPolicy } = await setup();
    const stub = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/article-1': () =>
        new Response('<html><head><title>Fetched Title</title></head><body>hi</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    });

    const detected = await makeDetected(monitor.id);
    const ctx = buildCtx(monitor, source, site, fetcherPolicy, stub);
    await enrichDetectedChanges(ctx, [detected]);

    expect(detected.row.title).toBe('Fetched Title');
    const persisted = await getChange(db(), detected.row.id);
    expect(persisted?.title).toBe('Fetched Title');
  });
});

describe('enrichDetectedChanges: non-fatal failures', () => {
  it('skips without throwing when the fetch fails (non-success status)', async () => {
    const { monitor, source, site, fetcherPolicy } = await setup();
    const stub = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
    }); // no handler for the article URL -> 404 from routedFetch's default

    const detected = await makeDetected(monitor.id);
    const ctx = buildCtx(monitor, source, site, fetcherPolicy, stub);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(enrichDetectedChanges(ctx, [detected])).resolves.toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }

    expect(detected.row.title).toBeNull();
    const persisted = await getChange(db(), detected.row.id);
    expect(persisted?.title).toBeNull();
  });

  it('skips without throwing when the content-type is not HTML', async () => {
    const { monitor, source, site, fetcherPolicy } = await setup();
    const stub = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/article-1': () =>
        new Response('{"title": "not html"}', { status: 200, headers: { 'content-type': 'application/json' } }),
    });

    const detected = await makeDetected(monitor.id);
    const ctx = buildCtx(monitor, source, site, fetcherPolicy, stub);
    await enrichDetectedChanges(ctx, [detected]);

    expect(detected.row.title).toBeNull();
  });

  it('skips without throwing when robots.txt disallows the URL', async () => {
    // 別ホストを使う: robots.txt キャッシュ (D1) は origin 単位で保持され、
    // it() 間で D1 がリセットされないため、他テスト (example.com を allow で埋める) と
    // 同一 origin を使うとキャッシュ衝突してしまう。
    const { monitor, source, site, fetcherPolicy } = await setup();
    const stub = routedFetch({
      'https://robots-disallow.example.com/robots.txt': () =>
        new Response('User-agent: *\nDisallow: /', { status: 200 }),
      'https://robots-disallow.example.com/article-1': () =>
        new Response('<html><head><title>Should Not Be Used</title></head></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });

    const detected = await makeDetected(monitor.id, { targetUrl: 'https://robots-disallow.example.com/article-1' });
    const ctx = buildCtx(monitor, source, site, fetcherPolicy, stub);
    await enrichDetectedChanges(ctx, [detected]);

    expect(detected.row.title).toBeNull();
  });

  it('skips without throwing when the SSRF policy blocks the URL', async () => {
    const { monitor, source, site, fetcherPolicy } = await setup();
    const stub = routedFetch({ [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1] });

    const detected = await makeDetected(monitor.id, { targetUrl: 'http://127.0.0.1/internal' });
    const ctx = buildCtx(monitor, source, site, fetcherPolicy, stub);
    await enrichDetectedChanges(ctx, [detected]);

    expect(detected.row.title).toBeNull();
  });

  it('skips without throwing when no title element is found', async () => {
    const { monitor, source, site, fetcherPolicy } = await setup();
    const stub = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/article-1': () =>
        new Response('<html><head></head><body>no title here</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });

    const detected = await makeDetected(monitor.id);
    const ctx = buildCtx(monitor, source, site, fetcherPolicy, stub);
    await enrichDetectedChanges(ctx, [detected]);

    expect(detected.row.title).toBeNull();
  });
});

describe('enrichDetectedChanges: budget (MAX_TITLE_FETCHES_PER_CHECK)', () => {
  it('stops fetching once the shared per-check budget is exhausted and warns once', async () => {
    const { monitor, source, site, fetcherPolicy } = await setup();
    const fetchedUrls: string[] = [];
    const stub = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
    });
    const trackingStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes('robots.txt') && !url.includes('dns-query')) fetchedUrls.push(url);
      return stub(input, init);
    }) as typeof fetch;

    const total = MAX_TITLE_FETCHES_PER_CHECK + 2;
    const detectedList: DetectedChange[] = [];
    for (let i = 0; i < total; i++) {
      detectedList.push(await makeDetected(monitor.id, { targetUrl: `https://example.com/budget-${i}` }));
    }

    const ctx = buildCtx(monitor, source, site, fetcherPolicy, trackingStub);
    // pre-seed the shared counter to confirm it is honored (as feed.ts would carry it across
    // multiple processFeedItems calls within one check).
    ctx.titleFetchesUsed = 0;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await enrichDetectedChanges(ctx, detectedList);
      const budgetWarnings = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('title fetch budget'),
      );
      expect(budgetWarnings).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }

    // routedFetch returns 404 for unhandled URLs (no per-article handler here), so titles stay
    // null, but the important assertion is the fetch attempt count itself.
    expect(fetchedUrls.length).toBe(MAX_TITLE_FETCHES_PER_CHECK);
    expect(ctx.titleFetchesUsed).toBe(MAX_TITLE_FETCHES_PER_CHECK);
  });

  it('honors a pre-seeded titleFetchesUsed (e.g. carried over from an earlier processFeedItems call in the same check), limiting fetches to the remaining budget', async () => {
    const { monitor, source, site, fetcherPolicy } = await setup();
    const fetchedUrls: string[] = [];
    const stub = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
    });
    const trackingStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes('robots.txt') && !url.includes('dns-query')) fetchedUrls.push(url);
      return stub(input, init);
    }) as typeof fetch;

    const preSeeded = 3;
    const remainingBudget = MAX_TITLE_FETCHES_PER_CHECK - preSeeded;
    const total = remainingBudget + 2; // more candidates than the remaining budget allows
    const detectedList: DetectedChange[] = [];
    for (let i = 0; i < total; i++) {
      detectedList.push(await makeDetected(monitor.id, { targetUrl: `https://example.com/preseed-budget-${i}` }));
    }

    const ctx = buildCtx(monitor, source, site, fetcherPolicy, trackingStub);
    ctx.titleFetchesUsed = preSeeded;

    await enrichDetectedChanges(ctx, detectedList);

    expect(fetchedUrls.length).toBe(remainingBudget);
    expect(ctx.titleFetchesUsed).toBe(MAX_TITLE_FETCHES_PER_CHECK);
  });
});
