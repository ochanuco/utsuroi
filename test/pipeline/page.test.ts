import { describe, expect, it, vi } from 'vitest';
import { runMonitorCheck } from '../../src/pipeline/runCheck';
import type { Env } from '../../src/shared/env';
import {
  getMonitor,
  listChangesByMonitor,
  listCheckJobsByMonitor,
  listDeliveriesByChange,
  listSnapshotsByMonitor,
} from '../../src/db';
import { buildPipelineFixture, db, fakeEnv, grantingLimiter, routedFetch } from './helpers';

describe('runMonitorCheck: page source (SPEC §12, §13)', () => {
  it('first check creates a snapshot without a Change (no baseline to diff against)', async () => {
    const { monitor } = await buildPipelineFixture({ sourceUrl: 'https://example.com/page' });
    const sendSpy = vi.fn();
    const fetchStub = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/page': () =>
        new Response('<html><body><h1>Hello</h1></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html', etag: '"v1"' },
        }),
    });

    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: sendSpy } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );

    expect(result.kind).toBe('completed');
    expect(result.changeIds).toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();

    const snapshots = await listSnapshotsByMonitor(db(), monitor.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.bodyHash).toBeTruthy();

    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(0);

    const jobs = await listCheckJobsByMonitor(db(), monitor.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('succeeded');

    const updatedMonitor = await getMonitor(db(), monitor.id);
    expect(updatedMonitor?.lastCheckedAt).toBeTruthy();
    expect(updatedMonitor?.nextRunAt).not.toBe(monitor.nextRunAt);
  });

  it('second check with changed content creates a Change + Delivery + queue send', async () => {
    const { monitor } = await buildPipelineFixture({ sourceUrl: 'https://example.com/page2' });
    const fetchStubV1 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/page2': () =>
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
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/page2': () =>
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
    expect(changes[0]?.kind).toBe('updated');
    expect(changes[0]?.diffPreview).toBeTruthy();

    const deliveries = await listDeliveriesByChange(db(), changes[0]!.id);
    expect(deliveries).toHaveLength(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith({ deliveryId: deliveries[0]!.id });
  });

  it('304 Not Modified is a successful no-op check (no new snapshot/change)', async () => {
    const { monitor } = await buildPipelineFixture({ sourceUrl: 'https://example.com/page3' });
    const fetchStubV1 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/page3': () =>
        new Response('<html><body>hi</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html', etag: '"same"' },
        }),
    });
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV1, hostLimiter: grantingLimiter() },
    );

    const fetchStubV2 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/page3': () => new Response(null, { status: 304, headers: { etag: '"same"' } }),
    });
    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV2, hostLimiter: grantingLimiter() },
    );

    expect(result.kind).toBe('completed');
    expect(result.changeIds).toHaveLength(0);
    const snapshots = await listSnapshotsByMonitor(db(), monitor.id);
    expect(snapshots).toHaveLength(1); // still just the first snapshot
  });

  it('releases the host lease even when downstream processing throws after a successful fetch', async () => {
    const { monitor } = await buildPipelineFixture({ sourceUrl: 'https://example.com/page4' });
    const fetchStubV1 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/page4': () =>
        new Response('<html><body><h1>Hello</h1></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    // baseline check: establishes the first snapshot so the second check has something to diff against
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV1, hostLimiter: grantingLimiter() },
    );

    const releaseCalls: Array<{ leaseId: string; opts: unknown }> = [];
    const fetchStubV2 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/page4': () =>
        new Response('<html><body><h1>Hello World</h1></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    const throwingSend = vi.fn(() => {
      throw new Error('queue unavailable');
    });

    await expect(
      runMonitorCheck(
        fakeEnv({ NOTIFY_QUEUE: { send: throwingSend } as unknown as Env['NOTIFY_QUEUE'] }),
        monitor.id,
        { fetch: fetchStubV2, hostLimiter: grantingLimiter(releaseCalls) },
      ),
    ).rejects.toThrow('queue unavailable');

    // the host lease acquired for this (second) check must still be released exactly once,
    // even though downstream notify processing threw before runMonitorCheck could return normally.
    expect(releaseCalls).toHaveLength(1);
  });

  it('recovers delivery/notify for a duplicate Change when a prior run crashed before delivery (at-least-once)', async () => {
    const { monitor } = await buildPipelineFixture({ sourceUrl: 'https://example.com/page5' });
    const fetchStubV1 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/page5': () =>
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

    const fetchStubV2 = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/page5': () =>
        new Response('<html><body><h1>Hello World</h1></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    const firstSend = vi.fn();
    const firstResult = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: firstSend } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV2, hostLimiter: grantingLimiter() },
    );
    expect(firstResult.changeIds).toHaveLength(1);
    expect(firstSend).toHaveBeenCalledTimes(1);

    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(1);
    const change = changes[0]!;

    const deliveriesBefore = await listDeliveriesByChange(db(), change.id);
    expect(deliveriesBefore).toHaveLength(1);

    // Simulate a crash that happened after the Change row (and its Snapshot) were committed
    // but before the Delivery row / NOTIFY_QUEUE enqueue completed: drop the Delivery, and
    // roll the latest Snapshot's timestamp behind the baseline one (rather than deleting it,
    // which would violate the changes/check_attempts -> snapshots FK) so getLatestSnapshotForTarget
    // sees the v1 baseline as "latest" again. A retry of the same v1->v2 fetch then regenerates
    // the identical dedupeKey (content-hash based) and hits the (monitor_id, dedupe_key) conflict.
    await db().prepare('DELETE FROM deliveries WHERE change_id = ?').bind(change.id).run();
    const snapshotsBeforeRetry = await listSnapshotsByMonitor(db(), monitor.id);
    const latestSnapshot = snapshotsBeforeRetry[0]!;
    await db()
      .prepare('UPDATE snapshots SET fetched_at = ?, created_at = ? WHERE id = ?')
      .bind('2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', latestSnapshot.id)
      .run();

    const retrySend = vi.fn();
    const retryResult = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: retrySend } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStubV2, hostLimiter: grantingLimiter() },
    );

    // Duplicate dedupeKey: must not be reported as a newly detected change for this run...
    expect(retryResult.changeIds).toHaveLength(0);
    const changesAfter = await listChangesByMonitor(db(), monitor.id);
    expect(changesAfter).toHaveLength(1); // no duplicate Change row inserted

    // ...but delivery/notify must still fire, since no Delivery existed yet for this Change.
    const deliveriesAfter = await listDeliveriesByChange(db(), change.id);
    expect(deliveriesAfter).toHaveLength(1);
    expect(retrySend).toHaveBeenCalledTimes(1);
  });
});
