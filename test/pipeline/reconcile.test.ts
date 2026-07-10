import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { runReconciliation } from '../../src/pipeline/reconcile';
import type { Env } from '../../src/shared/env';
import { buildPipelineFixture } from './helpers';

/**
 * env.MONITOR_DO をモックに差し替える。実 DO を経由すると、過去日時の nextRunAt が
 * 実際の Alarm を即発火させ (Miniflare は期限超過 Alarm を即実行する)、テストが実ネットワーク
 * fetch に依存してしまう。reconcile の責務は「対象を検出し scheduleMonitor を呼ぶこと」なので、
 * ここでは呼び出しの記録だけを検証する (MonitorObject 自体の Alarm 挙動は test/do/monitorObject.test.ts
 * で別途検証済み)。
 *
 * D1 はテストファイル内の it() 間でリセットされないため (他の fixture の行が残り得るため)、
 * 生の呼び出し回数ではなく「このテストで作った monitorId が呼ばれたかどうか」で検証する。
 */
function fakeReconcileEnv(onSchedule: (monitorId: string, nextRunAt: string | null) => void): Env {
  return {
    ...env,
    MONITOR_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        scheduleMonitor: async (monitorId: string, nextRunAt: string | null) => {
          onSchedule(monitorId, nextRunAt);
        },
      }),
    },
  } as unknown as Env;
}

describe('runReconciliation (ADR-0003: Alarm loss recovery)', () => {
  it('re-arms an active monitor overdue beyond the grace period', async () => {
    const scheduled = new Map<string, string | null>();
    const { monitor } = await buildPipelineFixture({ nextRunAt: '2020-01-01T00:00:00.000Z' });

    const { recovered } = await runReconciliation(fakeReconcileEnv((id, nextRunAt) => scheduled.set(id, nextRunAt)), {
      now: () => new Date('2026-07-10T00:10:00.000Z'),
    });

    expect(recovered).toBeGreaterThanOrEqual(1);
    expect(scheduled.has(monitor.id)).toBe(true);
    expect(scheduled.get(monitor.id)).toBe('2020-01-01T00:00:00.000Z');
  });

  it('does not touch a monitor whose next_run_at is within the grace window', async () => {
    const scheduled = new Set<string>();
    const { monitor } = await buildPipelineFixture({ nextRunAt: '2026-07-09T23:59:00.000Z' });

    await runReconciliation(fakeReconcileEnv((id) => scheduled.add(id)), {
      now: () => new Date('2026-07-10T00:00:00.000Z'),
      graceMs: 5 * 60_000,
    });

    // next_run_at is only 60s overdue, well within the 5 minute grace window
    expect(scheduled.has(monitor.id)).toBe(false);
  });

  it('ignores paused monitors even if their next_run_at is overdue', async () => {
    const scheduled = new Set<string>();
    const { monitor } = await buildPipelineFixture({
      nextRunAt: '2020-01-01T00:00:00.000Z',
      monitorStatus: 'paused',
    });

    await runReconciliation(fakeReconcileEnv((id) => scheduled.add(id)), {
      now: () => new Date('2026-07-10T00:10:00.000Z'),
    });

    expect(scheduled.has(monitor.id)).toBe(false);
  });

  it('isolates a single scheduleMonitor failure so later due monitors are still rescheduled', async () => {
    const { monitor: monitorA } = await buildPipelineFixture({ nextRunAt: '2020-01-01T00:00:00.000Z' });
    const { monitor: monitorB } = await buildPipelineFixture({ nextRunAt: '2020-01-01T00:00:01.000Z' });
    const { monitor: monitorC } = await buildPipelineFixture({ nextRunAt: '2020-01-01T00:00:02.000Z' });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scheduled = new Set<string>();

    const fakeEnv: Env = {
      ...env,
      MONITOR_DO: {
        idFromName: (name: string) => name,
        get: () => ({
          scheduleMonitor: async (monitorId: string) => {
            if (monitorId === monitorB.id) {
              throw new Error('DO unavailable');
            }
            scheduled.add(monitorId);
          },
        }),
      },
    } as unknown as Env;

    const { recovered } = await runReconciliation(fakeEnv, {
      now: () => new Date('2026-07-10T00:10:00.000Z'),
    });

    // monitorA (earlier next_run_at) and monitorC (later, iterated after the throwing monitorB)
    // must both still get scheduled: one failure must not abort the whole reconciliation loop.
    expect(scheduled.has(monitorA.id)).toBe(true);
    expect(scheduled.has(monitorC.id)).toBe(true);
    expect(scheduled.has(monitorB.id)).toBe(false);

    // `recovered` only counts successful reschedules; the failing monitorB must not be counted.
    // (D1 state isn't reset between it() calls in this file, so we can't assert an absolute total,
    // but every successful call in this fakeEnv is recorded in `scheduled`, so the two counts must match.)
    expect(recovered).toBe(scheduled.size);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'reconcile: failed to reschedule monitor',
      monitorB.id,
      expect.any(Error),
    );

    consoleErrorSpy.mockRestore();
  });
});
