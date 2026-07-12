import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { runMonitorCheck } from '../../src/pipeline/runCheck';
import type { Env } from '../../src/shared/env';
import type { HostLimiter } from '../../src/shared/contracts';
import { listCheckAttempts, listCheckJobsByMonitor } from '../../src/db';
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

describe('runMonitorCheck: entry-internal transient retry (ADR-0014)', () => {
  it('records each retry as its own CheckAttempt with increasing attempt_index, same fetcherId', async () => {
    const { monitor } = await buildPipelineFixture({ sourceUrl: 'https://example.com/flaky' });
    let calls = 0;
    const fetchStub = routedFetch({
      'https://example.com/robots.txt': () =>
        new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/flaky': () => {
        calls++;
        if (calls < 3) return new Response('unavailable', { status: 503 });
        return new Response('<html><body>ok</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
    });

    // fetchTargetThroughPolicy は runFetchSequence に opts を渡さないため、実際の
    // 250ms/500ms バックオフ (setTimeout ベースの既定 sleep) がそのまま使われる。
    // 実時間で待たないよう Vitest の fake timers で時間を進める。D1 (cloudflare:test)
    // 側の呼び出しはマイクロタスクで解決し、advanceTimersByTimeAsync の each tick で
    // マイクロタスクキューも flush されるため、実測でも詰まらず完走することを確認済み。
    vi.useFakeTimers();
    try {
      const resultPromise = runMonitorCheck(
        fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
        monitor.id,
        { fetch: fetchStub, hostLimiter: grantingLimiter() },
      );
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      expect(result.kind).toBe('completed');

      const jobs = await listCheckJobsByMonitor(db(), monitor.id);
      expect(jobs).toHaveLength(1);

      const attempts = await listCheckAttempts(db(), jobs[0]!.id);
      expect(attempts).toHaveLength(3);
      expect(attempts.map((a) => a.attemptIndex)).toEqual([0, 1, 2]);
      expect(attempts.every((a) => a.fetcherId === 'cf-http')).toBe(true);
      expect(attempts[0]?.outcome).toBe('failure');
      expect(attempts[0]?.failureClass).toBe('http_5xx');
      expect(attempts[1]?.outcome).toBe('failure');
      expect(attempts[1]?.failureClass).toBe('http_5xx');
      expect(attempts[2]?.outcome).toBe('success');
    } finally {
      vi.useRealTimers();
    }
  });
});
