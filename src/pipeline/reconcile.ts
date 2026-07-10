/**
 * Cron reconciliation (SPEC §10, ADR-0003): MonitorObject Alarm が消失した場合の復旧経路。
 * 期限超過 (猶予つき) の active monitor を検出し、各 MonitorObject の Alarm を再設定する。
 */
import { listMonitorsDue } from '../db';
import type { Env } from '../shared/env';

/** Alarm が正常に生きていれば自然発火しているはずの猶予期間。既定 5分 (wrangler.jsonc の cron 間隔と同オーダー) */
export const DEFAULT_RECONCILE_GRACE_MS = 5 * 60_000;

export interface RunReconciliationOptions {
  now?: () => Date;
  graceMs?: number;
}

export async function runReconciliation(
  env: Env,
  opts: RunReconciliationOptions = {},
): Promise<{ recovered: number }> {
  const now = opts.now ? opts.now().getTime() : Date.now();
  const graceMs = opts.graceMs ?? DEFAULT_RECONCILE_GRACE_MS;
  const asOf = new Date(now - graceMs).toISOString();

  const due = await listMonitorsDue(env.DB, asOf);
  let recovered = 0;

  for (const monitor of due) {
    const id = env.MONITOR_DO.idFromName(monitor.id);
    const stub = env.MONITOR_DO.get(id) as unknown as {
      scheduleMonitor(monitorId: string, nextRunAt: string | null): Promise<void>;
    };
    await stub.scheduleMonitor(monitor.id, monitor.nextRunAt);
    recovered += 1;
  }

  return { recovered };
}
