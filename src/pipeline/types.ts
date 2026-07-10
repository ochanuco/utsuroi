/**
 * src/pipeline/ 内部で共有する型。他レーンとの契約は src/shared/contracts.ts のみ。
 */
import type { FetcherPolicy } from '../shared/contracts';
import type { CheckJobRow, MonitorRow, SiteRow, SourceRow } from '../db';
import type { Env } from '../shared/env';

export type CheckRunKind = 'completed' | 'policy_stopped' | 'deferred' | 'skipped';

export interface CheckRunResult {
  kind: CheckRunKind;
  /** 次回 Alarm 時刻。null は Alarm 取消 (Policy Stop) を意味する */
  nextRunAt: string | null;
  /** kind='deferred' のときの推奨再試行待機 ms */
  retryAfterMs?: number;
  /** このチェックで新規作成された Change の ID (通知ファンアウト済み) */
  changeIds: string[];
}

export interface RunMonitorCheckOptions {
  /** テスト用の fetch 差し替え。robots.txt 取得・SSRF DoH 解決・HTTP fetch すべてに伝播する */
  fetch?: typeof fetch;
  /** テスト用の時刻注入 */
  now?: () => Date;
  /** テスト用の HostLimiter 差し替え。省略時は env.HOST_DO 経由の既定実装を使う */
  hostLimiter?: (origin: string) => import('../shared/contracts').HostLimiter;
  /**
   * 呼び出し種別。省略時 'scheduled'。
   * 'manual' は monitor が paused でも実行を許可する (MonitorObject.runNow 用、ADR-0003 手動実行サポート)。
   * 固定契約 (MonitorControl 等) には現れない、pipeline 内部の追加オプション。
   */
  trigger?: 'scheduled' | 'manual' | 'reconciliation';
}

/** 1回の runMonitorCheck 実行中に使い回す内部コンテキスト (feed.ts と runCheck.ts で共有) */
export interface CheckContext {
  env: Env;
  db: D1Database;
  monitor: MonitorRow;
  source: SourceRow;
  site: SiteRow;
  policy: FetcherPolicy;
  job: CheckJobRow;
  fetchImpl?: typeof fetch;
  /** epoch ms */
  now: () => number;
  changeIds: string[];
}

