import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { runMonitorCheck } from '../../src/pipeline/runCheck';
import type { Env } from '../../src/shared/env';
import type { HostLimiter } from '../../src/shared/contracts';
import {
  getLatestRobotsEvaluation,
  getMonitor,
  listCheckAttempts,
  listCheckJobsByMonitor,
  listSnapshotsByMonitor,
  upsertRobotsPolicy,
} from '../../src/db';
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

describe('runMonitorCheck: robots.txt (SPEC §9, ADR-0008/0009)', () => {
  it('enforce mode: a disallowed URL never gets fetched and Policy Stops the monitor', async () => {
    const { monitor } = await buildPipelineFixture({ sourceUrl: 'https://example.com/private/page' });
    const fetchSpy = vi.fn();
    const fetchStub = routedFetch({
      'https://example.com/robots.txt': () =>
        new Response('User-agent: *\nDisallow: /private', { status: 200 }),
      'https://example.com/private/page': (input, init) => {
        fetchSpy(input, init);
        return new Response('should not be fetched', { status: 200 });
      },
    });

    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );

    expect(result.kind).toBe('policy_stopped');
    expect(result.nextRunAt).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    const updatedMonitor = await getMonitor(db(), monitor.id);
    expect(updatedMonitor?.status).toBe('blocked_by_robots');
    expect(updatedMonitor?.stopReason).toBeTruthy();
    expect(updatedMonitor?.robotsEvaluationId).toBeTruthy();
    expect(updatedMonitor?.nextRunAt).toBeNull();

    const jobs = await listCheckJobsByMonitor(db(), monitor.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('policy_stopped');

    const attempts = await listCheckAttempts(db(), jobs[0]!.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.failureClass).toBe('blocked_by_robots');

    const snapshots = await listSnapshotsByMonitor(db(), monitor.id);
    expect(snapshots).toHaveLength(0);
  });

  it('ignore mode (ADR-0009): a disallowed URL is recorded as robots_would_block but the check continues', async () => {
    const { monitor, site } = await buildPipelineFixture({
      sourceUrl: 'https://example.com/private/page2',
    });
    await upsertRobotsPolicy(db(), {
      siteId: site.id,
      canonicalOrigin: 'https://example.com',
      mode: 'ignore',
      reason: 'site owner monitoring their own restricted area',
    });

    const fetchStub = routedFetch({
      'https://example.com/robots.txt': () =>
        new Response('User-agent: *\nDisallow: /private', { status: 200 }),
      'https://example.com/private/page2': () =>
        new Response('<html><body>secret</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });

    const result = await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );

    expect(result.kind).toBe('completed');

    const updatedMonitor = await getMonitor(db(), monitor.id);
    expect(updatedMonitor?.status).toBe('active');

    const snapshots = await listSnapshotsByMonitor(db(), monitor.id);
    expect(snapshots).toHaveLength(1);

    const evaluation = await getLatestRobotsEvaluation(db(), 'https://example.com');
    expect(evaluation?.verdict).toBe('disallowed');
    expect(evaluation?.robotsWouldBlock).toBe(true);
  });
});
