import { env } from 'cloudflare:test';
import type { DnsResolver } from '../../src/net';
import type { MonitorControl, MonitorControlFactory, MonitorControlStatus } from '../../src/shared/contracts';
import { createApp, type CreateAppOptions } from '../../src/api';

export const ADMIN_TOKEN = 'test-token';

/**
 * destinations.webhook_url 暗号化 (src/db/webhookCrypto.ts) 用の固定テストキー。
 * base64 エンコードされた 32 byte (AES-256-GCM 鍵長)。本番運用では wrangler secret として
 * 別途設定する想定で、ここではテストの決定性のためだけに固定値を使う。
 */
export const TEST_WEBHOOK_ENC_KEY = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=';

export function db(): D1Database {
  return env.DB;
}

/** app.request() の第3引数として渡す Env (テスト用トークンを注入) */
export function testEnv(overrides: Record<string, unknown> = {}) {
  return { ...env, ADMIN_TOKEN, WEBHOOK_ENC_KEY: TEST_WEBHOOK_ENC_KEY, ...overrides };
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_TOKEN}`, ...extra };
}

export function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...authHeaders(), 'content-type': 'application/json', ...extra };
}

/** DNS解決なしで完結する SSRF テスト用の resolver スタブ (公開IPを返す) */
export function stubPublicResolver(): DnsResolver {
  return {
    async resolve(_hostname: string, recordType: 'A' | 'AAAA'): Promise<string[]> {
      // 203.0.113.0/24 (TEST-NET-3, RFC 5737) はドキュメント用の予約アドレスであり
      // 実際にはグローバル到達可能ではないため、正真正銘のグローバル到達可能アドレス
      // (8.8.8.8) を返す。
      return recordType === 'A' ? ['8.8.8.8'] : [];
    },
  };
}

export interface FakeMonitorControlState {
  scheduled: Map<string, string | null>;
  running: Set<string>;
  paused: Set<string>;
  runNowResult: { started: boolean; reason: string | null };
  status: MonitorControlStatus | null;
}

/** テスト用 fake MonitorControlFactory。呼び出し履歴と戻り値を差し替え可能にする */
export function createFakeMonitorControlFactory(overrides: Partial<FakeMonitorControlState> = {}): {
  factory: (env: unknown) => MonitorControlFactory;
  state: FakeMonitorControlState;
} {
  const state: FakeMonitorControlState = {
    scheduled: new Map(),
    running: new Set(),
    paused: new Set(),
    runNowResult: { started: true, reason: null },
    status: null,
    ...overrides,
  };

  const factory: MonitorControlFactory = (monitorId: string): MonitorControl => ({
    schedule: async (nextRunAt) => {
      state.scheduled.set(monitorId, nextRunAt);
    },
    runNow: async () => state.runNowResult,
    pause: async () => {
      state.paused.add(monitorId);
    },
    resume: async () => {
      state.paused.delete(monitorId);
    },
    getStatus: async () =>
      state.status ?? {
        monitorId,
        nextRunAt: null,
        running: false,
        paused: state.paused.has(monitorId),
        lastResult: null,
      },
  });

  return { factory: () => factory, state };
}

export function buildTestApp(opts: Partial<CreateAppOptions> = {}) {
  const fake = createFakeMonitorControlFactory();
  const app = createApp({
    monitorControlFactory: opts.monitorControlFactory ?? fake.factory,
    ssrfResolver: opts.ssrfResolver ?? stubPublicResolver(),
  });
  return { app, fakeMonitorControl: fake.state };
}

let seq = 0;
export function uniqueName(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}
