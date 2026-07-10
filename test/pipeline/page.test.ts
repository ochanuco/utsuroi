import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { runMonitorCheck } from '../../src/pipeline/runCheck';
import type { Env } from '../../src/shared/env';
import type { HostLimiter } from '../../src/shared/contracts';
import {
  getMonitor,
  listChangesByMonitor,
  listCheckJobsByMonitor,
  listDeliveriesByChange,
  listSnapshotsByMonitor,
} from '../../src/db';
import { buildPipelineFixture, db, routedFetch } from './helpers';

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, ...overrides } as Env;
}

/** テストでは HostObject 自体を経由せず、常に即時許可する HostLimiter を注入する */
function grantingLimiter(): (origin: string) => HostLimiter {
  let counter = 0;
  return () => ({
    acquire: async () => ({ granted: true, leaseId: `lease-${counter++}`, retryAfterMs: null }),
    release: async () => {},
  });
}

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
});
