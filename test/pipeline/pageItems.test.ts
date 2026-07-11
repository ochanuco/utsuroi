/**
 * page Source の「新着検知」(アイテム抽出) モード (ADR-0011)。
 * config.pageMode === 'extract' の page Source が既定の processPageContent (本文差分) ではなく
 * src/pipeline/pageItems.ts の processPageItems に到達し、CSSセレクタで切り出したアイテムの
 * 実URLを processFeedItems (feed.ts) 経由で new/updated 検知・通知することを検証する。
 */
import { describe, expect, it, vi } from 'vitest';
import { runMonitorCheck } from '../../src/pipeline/runCheck';
import type { Env } from '../../src/shared/env';
import {
  listChangesByMonitor,
  listDeliveriesByChange,
  listSnapshotsByMonitor,
  listTargetsByMonitor,
} from '../../src/db';
import { buildPipelineFixture, db, fakeEnv, grantingLimiter, routedFetch } from './helpers';

const ROBOTS_ALLOW: [string, () => Response] = [
  'https://example.com/robots.txt',
  () => new Response('User-agent: *\nAllow: /', { status: 200 }),
];

function listingHtml(items: Array<{ href: string; title: string }>): string {
  return `<html><body><ul>
    ${items
      .map((i) => `<li class="property_unit"><h2>${i.title}</h2><a href="${i.href}">detail</a></li>`)
      .join('\n')}
  </ul></body></html>`;
}

describe('runMonitorCheck: page item extraction (ADR-0011) baseline', () => {
  it('registers item Targets from the extracted list but creates zero Changes and sends no notification', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'page',
      sourceUrl: 'https://example.com/listing-baseline',
      sourceConfig: { pageMode: 'extract', extract: { itemSelector: '.property_unit', titleSelector: 'h2' } },
    });
    const sendSpy = vi.fn();
    const fetchStub = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/listing-baseline': () =>
        new Response(
          listingHtml([
            { href: '/units/1', title: 'Unit One' },
            { href: '/units/2', title: 'Unit Two' },
          ]),
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
    });

    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: sendSpy } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );

    expect(result.kind).toBe('completed');
    expect(result.changeIds).toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();

    // Source自体 (listing page) + 抽出された2アイテムの3 Target。
    const targets = await listTargetsByMonitor(db(), monitor.id);
    expect(targets).toHaveLength(3);
    expect(targets.some((t) => t.url === 'https://example.com/units/1')).toBe(true);
    expect(targets.some((t) => t.url === 'https://example.com/units/2')).toBe(true);

    expect(await listChangesByMonitor(db(), monitor.id)).toHaveLength(0);

    // pageContent (本文差分) 経路は通らないため、Snapshot は normalizedHash 等を持たない
    // (processFeedContent と同じ記録方針)。
    const snapshots = await listSnapshotsByMonitor(db(), monitor.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.normalizedHash).toBeNull();
  });
});

describe('runMonitorCheck: page item extraction incremental detection', () => {
  it('detects a newly-appeared item as a new Change with title/url and delivers it', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'page',
      sourceUrl: 'https://example.com/listing-inc',
      sourceConfig: { pageMode: 'extract', extract: { itemSelector: '.property_unit', titleSelector: 'h2' } },
    });

    const baselineStub = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/listing-inc': () =>
        new Response(listingHtml([{ href: '/units/a', title: 'Unit A' }]), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: baselineStub, hostLimiter: grantingLimiter() },
    );

    // 2回目: 新しいアイテム (Unit B) が追加される。
    const sendSpy = vi.fn();
    const secondStub = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/listing-inc': () =>
        new Response(
          listingHtml([
            { href: '/units/a', title: 'Unit A' },
            { href: '/units/b', title: 'Unit B' },
          ]),
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
    });
    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: sendSpy } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: secondStub, hostLimiter: grantingLimiter() },
    );

    expect(result.kind).toBe('completed');
    expect(result.changeIds).toHaveLength(1);

    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('new');
    expect(changes[0]?.targetUrl).toBe('https://example.com/units/b');
    expect(changes[0]?.title).toBe('Unit B');

    const deliveries = await listDeliveriesByChange(db(), changes[0]!.id);
    expect(deliveries).toHaveLength(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith({ deliveryId: deliveries[0]!.id });
  });

  it('creates zero Changes when a later check only re-observes already-known items', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'page',
      sourceUrl: 'https://example.com/listing-stable',
      sourceConfig: { pageMode: 'extract', extract: { itemSelector: '.property_unit', titleSelector: 'h2' } },
    });

    const items = [
      { href: '/units/x', title: 'Unit X' },
      { href: '/units/y', title: 'Unit Y' },
    ];
    const stub = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/listing-stable': () =>
        new Response(listingHtml(items), { status: 200, headers: { 'content-type': 'text/html' } }),
    });

    // baseline: 2件とも Target 化されるが (processFeedItems は baseline でも Target upsert は行う)、
    // Change は作らない。
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: stub, hostLimiter: grantingLimiter() },
    );
    const changesAfterBaseline = await listChangesByMonitor(db(), monitor.id);
    expect(changesAfterBaseline).toHaveLength(0);

    // 2回目: 全く同じ2件のみが観測される (新規アイテム無し、updatedAt も無いため 'updated' も出ない)
    // → Change 0件のまま。
    const sendSpy = vi.fn();
    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: sendSpy } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: stub, hostLimiter: grantingLimiter() },
    );
    expect(result.kind).toBe('completed');
    expect(result.changeIds).toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();

    const changesAfterSecond = await listChangesByMonitor(db(), monitor.id);
    expect(changesAfterSecond).toHaveLength(0);
  });
});

describe('runMonitorCheck: page without pageMode config still uses content-diff (processPageContent)', () => {
  it('a page Source with no config takes the body-diff path, not item extraction', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceType: 'page',
      sourceUrl: 'https://example.com/plain-page',
    });
    const fetchStubV1 = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/plain-page': () =>
        new Response('<html><body><h1>Hello</h1></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV1, hostLimiter: grantingLimiter() },
    );

    const sendSpy = vi.fn();
    const fetchStubV2 = routedFetch({
      [ROBOTS_ALLOW[0]]: ROBOTS_ALLOW[1],
      'https://example.com/plain-page': () =>
        new Response('<html><body><h1>Hello World</h1></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: sendSpy } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV2, hostLimiter: grantingLimiter() },
    );

    expect(result.kind).toBe('completed');
    expect(result.changeIds).toHaveLength(1);
    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('updated'); // 'new' ではなく本文差分の 'updated' (processPageContent 経路)
    expect(changes[0]?.diffPreview).toBeTruthy();

    // 本文差分経路の Snapshot は normalizedHash を持つ (processPageItems と区別する検証)。
    const snapshots = await listSnapshotsByMonitor(db(), monitor.id);
    expect(snapshots[snapshots.length - 1]?.normalizedHash).toBeTruthy();
  });
});
