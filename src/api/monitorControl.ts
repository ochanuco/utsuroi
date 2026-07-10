/**
 * MonitorObject (src/do/, 別レーン実装中) を叩く既定の MonitorControlFactory。
 *
 * DO側の実装はまだ存在しない (src/index.ts の MonitorObject は空のスタブ)。ここでは
 * env.MONITOR_DO.idFromName(monitorId) で得た stub に対し、固定シグネチャの RPC
 * (scheduleMonitor/runNowMonitor/pauseMonitor/resumeMonitor/getMonitorStatus) を
 * 呼ぶだけの薄いアダプタとして実装する。DOにこれらのメソッドが実装されるまでは
 * 実行時には失敗しうるため、テストでは必ず createApp(opts) で fake factory を注入する。
 * この既定実装は型レベルの整合性確認のみを目的とする。
 */
import type { Env } from '../shared/env';
import type { MonitorControl, MonitorControlFactory, MonitorControlStatus } from '../shared/contracts';

/** MonitorObject DO が公開する (予定の) RPC メソッド群の固定シグネチャ */
export interface MonitorDoRpc {
  scheduleMonitor(monitorId: string, nextRunAt: string | null): Promise<void>;
  runNowMonitor(monitorId: string): Promise<{ started: boolean; reason: string | null }>;
  pauseMonitor(monitorId: string): Promise<void>;
  resumeMonitor(monitorId: string): Promise<void>;
  getMonitorStatus(monitorId: string): Promise<MonitorControlStatus>;
}

export function createDefaultMonitorControlFactory(env: Env): MonitorControlFactory {
  return (monitorId: string): MonitorControl => {
    const id = env.MONITOR_DO.idFromName(monitorId);
    const stub = env.MONITOR_DO.get(id) as unknown as MonitorDoRpc;

    return {
      schedule: (nextRunAt) => stub.scheduleMonitor(monitorId, nextRunAt),
      runNow: () => stub.runNowMonitor(monitorId),
      pause: () => stub.pauseMonitor(monitorId),
      resume: () => stub.resumeMonitor(monitorId),
      getStatus: () => stub.getMonitorStatus(monitorId),
    };
  };
}
