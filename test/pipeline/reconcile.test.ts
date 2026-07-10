import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
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
});
