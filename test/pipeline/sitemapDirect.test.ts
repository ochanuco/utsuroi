/**
 * ADR-0010 Phase A (Sitemap Direct, docs/adr/0010-detection-chain-and-source-promotion.md):
 * sitemap / sitemap-index Source は既定で「指定した1つの階層に列挙されている URL集合を
 * 1つのドキュメントとして snapshot+diff する」processSitemapDirect に到達する。
 * 子を辿らない・個々のURLをTarget化しない (実障害: hira2 の sitemap-index が 6,021 件の
 * Target を作りジョブを止めた再発防止) ことをここで検証する。
 */
import { describe, expect, it, vi } from 'vitest';
import { runMonitorCheck } from '../../src/pipeline/runCheck';
import { buildSitemapDocument } from '../../src/pipeline/sitemapDirect';
import type { Env } from '../../src/shared/env';
import type { FeedItem } from '../../src/shared/contracts';
import {
  listChangesByMonitor,
  listDeliveriesByChange,
  listSnapshotsByMonitor,
  listTargetsByMonitor,
} from '../../src/db';
import { buildPipelineFixture, db, fakeEnv, grantingLimiter, routedFetch } from './helpers';

function sitemapIndexBody(locs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `  <sitemap><loc>${loc}</loc></sitemap>`).join('\n')}
</sitemapindex>`;
}

function urlsetBody(entries: Array<{ loc: string; lastmod?: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map((e) => `  <url><loc>${e.loc}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}</url>`)
  .join('\n')}
</urlset>`;
}

describe('buildSitemapDocument', () => {
  it('normalizes items into a loc-sorted, deduped, deterministic document', () => {
    const items: FeedItem[] = [
      { stableKey: 'b', url: 'https://example.com/b', title: null, publishedAt: null, updatedAt: null, summary: null },
      {
        stableKey: 'a',
        url: 'https://example.com/a',
        title: null,
        publishedAt: null,
        updatedAt: '2024-01-01T00:00:00.000Z',
        summary: null,
      },
      // duplicate loc: first occurrence wins
      {
        stableKey: 'a-dup',
        url: 'https://example.com/a',
        title: null,
        publishedAt: null,
        updatedAt: '2099-01-01T00:00:00.000Z',
        summary: null,
      },
      { stableKey: 'no-url', url: null, title: null, publishedAt: null, updatedAt: null, summary: null },
    ];
    expect(buildSitemapDocument(items)).toBe(
      'https://example.com/a\t2024-01-01T00:00:00.000Z\nhttps://example.com/b\t-\n',
    );
  });

  it('returns an empty string for an empty item set', () => {
    expect(buildSitemapDocument([])).toBe('');
  });
});

describe('runMonitorCheck: sitemap-index Direct baseline (ADR-0010 Phase A, incident: www.hira2.jp 6,021 URLs)', () => {
  it('creates exactly one Target (the Source URL itself) and zero Changes on the first check, even with 6,021 child sitemap entries', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/big-sitemap-index.xml',
    });
    const locs = Array.from({ length: 6021 }, (_, i) => `https://example.com/child-${i}.xml`);
    const sendSpy = vi.fn();
    const fetchStub = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/big-sitemap-index.xml': () =>
        new Response(sitemapIndexBody(locs), { status: 200, headers: { 'content-type': 'application/xml' } }),
    });

    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: sendSpy } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );

    expect(result.kind).toBe('completed');
    expect(result.changeIds).toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();

    // Target爆発が起きないことの核心: 6,021件の child loc があっても Target は
    // Source URL 自体の1件だけ (個々のURLをTarget化しない, ADR-0010 モードA)。
    const targets = await listTargetsByMonitor(db(), monitor.id);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.url).toBe('https://example.com/big-sitemap-index.xml');

    // snapshotも1件 (URL集合ドキュメント全体で1つ)。
    const snapshots = await listSnapshotsByMonitor(db(), monitor.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.textHash).toBeTruthy();

    expect(await listChangesByMonitor(db(), monitor.id)).toHaveLength(0);
  });
});

describe('runMonitorCheck: sitemap-index Direct increment/decrement detection', () => {
  it('detects a newly-added child loc as a single "updated" Change with the diff showing +1, and delivers it', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/sitemap-index-inc.xml',
    });
    const fetchStubV1 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-index-inc.xml': () =>
        new Response(sitemapIndexBody(['https://example.com/a.xml', 'https://example.com/b.xml']), {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        }),
    });

    const first = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV1, hostLimiter: grantingLimiter() },
    );
    expect(first.changeIds).toHaveLength(0);

    const sendSpy = vi.fn();
    const fetchStubV2 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-index-inc.xml': () =>
        new Response(
          sitemapIndexBody([
            'https://example.com/a.xml',
            'https://example.com/b.xml',
            'https://example.com/c.xml',
          ]),
          { status: 200, headers: { 'content-type': 'application/xml' } },
        ),
    });
    const second = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: sendSpy } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV2, hostLimiter: grantingLimiter() },
    );

    expect(second.kind).toBe('completed');
    expect(second.changeIds).toHaveLength(1);

    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('updated');
    expect(changes[0]?.diffLevel).toBe('text_hash');
    expect(changes[0]?.diffPreview).toContain('+1/-0');
    expect(changes[0]?.diffPreview).toContain('https://example.com/c.xml');

    // 増分検知でも Target は Source URL 自体の1件のみ (子 loc は Target 化されない)。
    const targets = await listTargetsByMonitor(db(), monitor.id);
    expect(targets).toHaveLength(1);

    const deliveries = await listDeliveriesByChange(db(), changes[0]!.id);
    expect(deliveries).toHaveLength(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith({ deliveryId: deliveries[0]!.id });
  });

  it('detects a removed child loc as a single "updated" Change with the diff showing -1', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/sitemap-index-dec.xml',
    });
    const fetchStubV1 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-index-dec.xml': () =>
        new Response(
          sitemapIndexBody([
            'https://example.com/a.xml',
            'https://example.com/b.xml',
            'https://example.com/c.xml',
          ]),
          { status: 200, headers: { 'content-type': 'application/xml' } },
        ),
    });
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV1, hostLimiter: grantingLimiter() },
    );

    const fetchStubV2 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-index-dec.xml': () =>
        new Response(sitemapIndexBody(['https://example.com/a.xml', 'https://example.com/b.xml']), {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        }),
    });
    const second = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV2, hostLimiter: grantingLimiter() },
    );

    expect(second.changeIds).toHaveLength(1);
    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('updated');
    expect(changes[0]?.diffPreview).toContain('+0/-1');
    expect(changes[0]?.diffPreview).toContain('https://example.com/c.xml');
  });

  it('re-checking identical content a third time creates no additional Change/notification', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/sitemap-index-stable.xml',
    });
    const fetchStub = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-index-stable.xml': () =>
        new Response(sitemapIndexBody(['https://example.com/a.xml']), {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        }),
    });

    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );
    const thirdSend = vi.fn();
    const third = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: thirdSend } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );

    expect(third.changeIds).toHaveLength(0);
    expect(thirdSend).not.toHaveBeenCalled();
    expect(await listChangesByMonitor(db(), monitor.id)).toHaveLength(0);
  });
});

describe('runMonitorCheck: sitemap-index Direct lastmod change detection', () => {
  it('detects a lastmod-only change (loc set unchanged) as an "updated" Change whose diff shows the new lastmod', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap-index',
      sourceUrl: 'https://example.com/sitemap-index-lastmod.xml',
    });
    const fetchStubV1 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-index-lastmod.xml': () =>
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/a.xml</loc><lastmod>2024-01-01</lastmod></sitemap>
</sitemapindex>`,
          { status: 200, headers: { 'content-type': 'application/xml' } },
        ),
    });
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV1, hostLimiter: grantingLimiter() },
    );

    const fetchStubV2 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/sitemap-index-lastmod.xml': () =>
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/a.xml</loc><lastmod>2024-02-02</lastmod></sitemap>
</sitemapindex>`,
          { status: 200, headers: { 'content-type': 'application/xml' } },
        ),
    });
    const second = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV2, hostLimiter: grantingLimiter() },
    );

    expect(second.changeIds).toHaveLength(1);
    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('updated');
    // loc集合の増減は無い (同一URL) が、lastmod列の更新で diff は出る (+1/-1: 1行の置換)。
    expect(changes[0]?.diffPreview).toContain('+1/-1');
    expect(changes[0]?.diffPreview).toContain(new Date('2024-02-02').toISOString());
  });
});

describe('runMonitorCheck: urlset (sitemap) Direct behaves the same as sitemap-index Direct', () => {
  it('baselines on first check, then detects a newly-added URL as one "updated" Change without creating per-URL Targets', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'sitemap',
      sourceUrl: 'https://example.com/urlset-direct.xml',
    });
    const fetchStubV1 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/urlset-direct.xml': () =>
        new Response(urlsetBody([{ loc: 'https://example.com/a' }, { loc: 'https://example.com/b' }]), {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        }),
    });

    const first = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV1, hostLimiter: grantingLimiter() },
    );
    expect(first.changeIds).toHaveLength(0);
    expect(await listTargetsByMonitor(db(), monitor.id)).toHaveLength(1);

    const sendSpy = vi.fn();
    const fetchStubV2 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/urlset-direct.xml': () =>
        new Response(
          urlsetBody([
            { loc: 'https://example.com/a' },
            { loc: 'https://example.com/b' },
            { loc: 'https://example.com/c' },
          ]),
          { status: 200, headers: { 'content-type': 'application/xml' } },
        ),
    });
    const second = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: sendSpy } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV2, hostLimiter: grantingLimiter() },
    );

    expect(second.changeIds).toHaveLength(1);
    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('updated');
    expect(changes[0]?.diffPreview).toContain('+1/-0');
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // urlset Direct でも実URLをTarget化しない: Target は Source URL 自体の1件のみ。
    const targets = await listTargetsByMonitor(db(), monitor.id);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.url).toBe('https://example.com/urlset-direct.xml');
  });
});
