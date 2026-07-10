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
import type { MonitorControl, MonitorControlFactory, MonitorDoRpc } from '../shared/contracts';

/** MonitorObject DO の RPC 契約は src/shared/contracts.ts の単一定義を再利用する (重複定義しない) */
export type { MonitorDoRpc } from '../shared/contracts';

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
