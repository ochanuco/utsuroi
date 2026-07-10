/**
 * MonitorObject: monitor_id 単位の Alarm 駆動スケジューラ (SPEC §10, §11, ADR-0002/0003)。
 *
 * - 次回 Alarm の保持 (ctx.storage の Alarm API)
 * - 実行中ジョブの直列化 (in-memory `running` フラグ。DO は単一実行なのでこれで十分)
 * - pause/resume: Alarm 取消/再設定 + D1 monitor.status 同期
 * - runNow: 手動実行。実行中なら started:false
 */
import { DurableObject } from 'cloudflare:workers';
import type {
  MonitorControl,
  MonitorControlFactory,
  MonitorControlStatus,
} from '../shared/contracts';
import type { CheckJobStatus } from '../shared/types';
import type { Env } from '../shared/env';
import { getMonitor, setMonitorNextRun, updateMonitorStatus } from '../db';
import { runMonitorCheck } from '../pipeline/runCheck';
import type { CheckRunResult } from '../pipeline/types';

interface LastResult {
  status: CheckJobStatus;
  at: string;
}

/** CheckRunResult.kind (pipeline の宙ぶらりんな結果種別) を MonitorControlStatus.lastResult.status へ
 * 近似する。'completed' は成功・SSRF失敗のどちらもあり得るが、pipeline はこれ以上の粒度を
 * kind に含めないため 'succeeded' 扱いにする (report で明記する設計判断)。 */
function toLastResultStatus(kind: CheckRunResult['kind']): CheckJobStatus {
  switch (kind) {
    case 'completed':
      return 'succeeded';
    case 'policy_stopped':
      return 'policy_stopped';
    case 'deferred':
      return 'pending';
    case 'skipped':
      return 'pending';
  }
}

export class MonitorObject extends DurableObject<Env> {
  private running = false;

  /** テスト用フック (report 参照): 実 fetch/時刻の代わりに注入する */
  testFetch?: typeof fetch;
  testNow?: () => Date;

  private async getMonitorId(): Promise<string | null> {
    return (await this.ctx.storage.get<string>('monitorId')) ?? null;
  }

  private async bindMonitorId(monitorId: string): Promise<void> {
    const existing = await this.getMonitorId();
    if (existing && existing !== monitorId) {
      throw new Error(
        `MonitorObject: monitorId mismatch (bound to ${existing}, called with ${monitorId})`,
      );
    }
    if (!existing) {
      await this.ctx.storage.put('monitorId', monitorId);
    }
  }

  async scheduleMonitor(monitorId: string, nextRunAt: string | null): Promise<void> {
    await this.bindMonitorId(monitorId);
    if (nextRunAt === null) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(new Date(nextRunAt));
    }
  }

  async runNowMonitor(monitorId: string): Promise<{ started: boolean; reason: string | null }> {
    await this.bindMonitorId(monitorId);
    if (this.running) {
      return { started: false, reason: 'a check is already running for this monitor' };
    }
    this.running = true;
    try {
      const result = await runMonitorCheck(this.env, monitorId, {
        fetch: this.testFetch,
        now: this.testNow,
        trigger: 'manual',
      });
      await this.applyResult(result);
      return { started: true, reason: null };
    } finally {
      this.running = false;
    }
  }

  async pauseMonitor(monitorId: string): Promise<void> {
    await this.bindMonitorId(monitorId);
    await this.ctx.storage.deleteAlarm();
    await updateMonitorStatus(this.env.DB, monitorId, 'paused');
  }

  async resumeMonitor(monitorId: string): Promise<void> {
    await this.bindMonitorId(monitorId);
    await updateMonitorStatus(this.env.DB, monitorId, 'active');
    const monitor = await getMonitor(this.env.DB, monitorId);
    const nextRunAt = monitor?.nextRunAt ?? new Date().toISOString();
    if (!monitor?.nextRunAt) {
      await setMonitorNextRun(this.env.DB, monitorId, nextRunAt);
    }
    await this.ctx.storage.setAlarm(new Date(nextRunAt));
  }

  async getMonitorStatus(monitorId: string): Promise<MonitorControlStatus> {
    await this.bindMonitorId(monitorId);
    const monitor = await getMonitor(this.env.DB, monitorId);
    const lastResult = (await this.ctx.storage.get<LastResult>('lastResult')) ?? null;
    return {
      monitorId,
      nextRunAt: monitor?.nextRunAt ?? null,
      running: this.running,
      paused: monitor?.status === 'paused',
      lastResult,
    };
  }

  async alarm(): Promise<void> {
    const monitorId = await this.getMonitorId();
    if (!monitorId) return;
    // 未完了ジョブがあれば重複起動しない (SPEC §10)。alarm は runtime が直列化するが、
    // runNow との競合に備えて防御的にもフラグを見る。
    if (this.running) return;
    this.running = true;
    try {
      const result = await runMonitorCheck(this.env, monitorId, {
        fetch: this.testFetch,
        now: this.testNow,
        trigger: 'scheduled',
      });
      await this.applyResult(result);
    } finally {
      this.running = false;
    }
  }

  private async applyResult(result: CheckRunResult): Promise<void> {
    const lastResult: LastResult = {
      status: toLastResultStatus(result.kind),
      at: (this.testNow?.() ?? new Date()).toISOString(),
    };
    await this.ctx.storage.put('lastResult', lastResult);

    if (result.kind === 'policy_stopped') {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (result.kind === 'deferred') {
      const retryAt = Date.now() + (result.retryAfterMs ?? 5000);
      await this.ctx.storage.setAlarm(retryAt);
      return;
    }
    if (result.kind === 'skipped') {
      // active でない (paused/archived/blocked_by_robots) か、同一スロットの重複起動。
      // Alarm はそのまま (再設定しない): paused は pauseMonitor が既に取消済み、
      // archived/blocked_by_robots も Alarm は無いはず。重複起動時は次回 Alarm を保持する。
      return;
    }
    if (result.nextRunAt) {
      await this.ctx.storage.setAlarm(new Date(result.nextRunAt));
    }
  }
}

/** monitorId から MonitorControl を得る Factory (src/api がこれを注入して使う) */
export function monitorControlFactory(env: Env): MonitorControlFactory {
  return (monitorId: string): MonitorControl => {
    const id = env.MONITOR_DO.idFromName(monitorId);
    const stub = env.MONITOR_DO.get(id) as unknown as {
      scheduleMonitor(monitorId: string, nextRunAt: string | null): Promise<void>;
      runNowMonitor(monitorId: string): Promise<{ started: boolean; reason: string | null }>;
      pauseMonitor(monitorId: string): Promise<void>;
      resumeMonitor(monitorId: string): Promise<void>;
      getMonitorStatus(monitorId: string): Promise<MonitorControlStatus>;
    };
    return {
      schedule: (nextRunAt) => stub.scheduleMonitor(monitorId, nextRunAt),
      runNow: () => stub.runNowMonitor(monitorId),
      pause: () => stub.pauseMonitor(monitorId),
      resume: () => stub.resumeMonitor(monitorId),
      getStatus: () => stub.getMonitorStatus(monitorId),
    };
  };
}
