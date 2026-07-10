/**
 * HostObject: canonical origin 単位の rate limit / lease / backoff / circuit breaker (SPEC §11, ADR-0002)。
 * Fetcher を跨いで共有する (ADR-0005 Guardrail)。
 *
 * 既定パラメータ (設計判断、report 参照):
 * - 最小アクセス間隔: 10秒
 * - 最大同時実行数: 2
 * - lease TTL: 60秒 (release() を呼ばずに終わった lease は自動失効させる)
 * - 失敗連続 5回で circuit breaker open (5分間 acquire を拒否)
 * - backoff は失敗連続回数に対する指数バックオフ (10s, 20s, 40s, ...上限5分)。
 *   http_429 の retryAfterSeconds が指定されていれば、その方が長い場合はそちらを優先する。
 */
import { DurableObject } from 'cloudflare:workers';
import type { HostLeaseResult, HostLimiter } from '../shared/contracts';
import type { FailureClass } from '../shared/types';
import type { Env } from '../shared/env';

export const MIN_ACCESS_INTERVAL_MS = 10_000;
export const MAX_CONCURRENT_LEASES = 2;
export const LEASE_TTL_MS = 60_000;
export const CIRCUIT_BREAKER_THRESHOLD = 5;
export const CIRCUIT_OPEN_MS = 5 * 60_000;
const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60_000;

interface HostState {
  /** leaseId -> granted-at epoch ms */
  activeLeases: Record<string, number>;
  /** 直近 acquire 許可時刻 (最小アクセス間隔の起点) */
  lastAcquireAt: number | null;
  /** backoff/Retry-After により、この時刻より前は acquire を許可しない */
  nextAllowedAt: number | null;
  failureStreak: number;
  circuitOpenUntil: number | null;
}

function emptyState(): HostState {
  return {
    activeLeases: {},
    lastAcquireAt: null,
    nextAllowedAt: null,
    failureStreak: 0,
    circuitOpenUntil: null,
  };
}

function backoffMsFor(failureStreak: number): number {
  if (failureStreak <= 0) return 0;
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (failureStreak - 1));
}

export class HostObject extends DurableObject<Env> {
  /** テスト用の時刻注入。未設定時は Date.now() (report 参照) */
  nowOverride?: () => number;

  private now(): number {
    return this.nowOverride ? this.nowOverride() : Date.now();
  }

  private async loadState(): Promise<HostState> {
    const state = await this.ctx.storage.get<HostState>('state');
    return state ?? emptyState();
  }

  private async saveState(state: HostState): Promise<void> {
    await this.ctx.storage.put('state', state);
  }

  private expireStaleLeases(state: HostState, now: number): void {
    for (const [leaseId, grantedAt] of Object.entries(state.activeLeases)) {
      if (now - grantedAt >= LEASE_TTL_MS) {
        delete state.activeLeases[leaseId];
      }
    }
  }

  async acquireLease(): Promise<HostLeaseResult> {
    const now = this.now();
    const state = await this.loadState();
    this.expireStaleLeases(state, now);

    if (state.circuitOpenUntil !== null && now < state.circuitOpenUntil) {
      return { granted: false, leaseId: null, retryAfterMs: state.circuitOpenUntil - now };
    }
    if (state.circuitOpenUntil !== null && now >= state.circuitOpenUntil) {
      // breaker window elapsed: half-open. Allow one probe through by clearing the breaker state.
      state.circuitOpenUntil = null;
    }

    if (Object.keys(state.activeLeases).length >= MAX_CONCURRENT_LEASES) {
      await this.saveState(state);
      return { granted: false, leaseId: null, retryAfterMs: MIN_ACCESS_INTERVAL_MS };
    }

    const earliestNext = Math.max(
      state.lastAcquireAt !== null ? state.lastAcquireAt + MIN_ACCESS_INTERVAL_MS : 0,
      state.nextAllowedAt ?? 0,
    );
    if (now < earliestNext) {
      await this.saveState(state);
      return { granted: false, leaseId: null, retryAfterMs: earliestNext - now };
    }

    const leaseId = crypto.randomUUID();
    state.activeLeases[leaseId] = now;
    state.lastAcquireAt = now;
    await this.saveState(state);
    return { granted: true, leaseId, retryAfterMs: null };
  }

  async releaseLease(
    leaseId: string,
    outcome: { failureClass: FailureClass | null; retryAfterSeconds: number | null },
  ): Promise<void> {
    const now = this.now();
    const state = await this.loadState();
    delete state.activeLeases[leaseId];

    if (outcome.failureClass === null) {
      state.failureStreak = 0;
      state.circuitOpenUntil = null;
      state.nextAllowedAt = null;
    } else {
      state.failureStreak += 1;
      let waitMs = backoffMsFor(state.failureStreak);
      if (outcome.failureClass === 'http_429' && outcome.retryAfterSeconds !== null) {
        waitMs = Math.max(waitMs, outcome.retryAfterSeconds * 1000);
      }
      state.nextAllowedAt = now + waitMs;
      if (state.failureStreak >= CIRCUIT_BREAKER_THRESHOLD) {
        state.circuitOpenUntil = now + CIRCUIT_OPEN_MS;
      }
    }

    await this.saveState(state);
  }
}

/** monitorId から MonitorControl を得るのと対称に、origin から HostLimiter を得る */
export function hostLimiterFactory(env: Env): (origin: string) => HostLimiter {
  return (origin: string): HostLimiter => {
    const id = env.HOST_DO.idFromName(origin);
    const stub = env.HOST_DO.get(id) as unknown as {
      acquireLease(): Promise<HostLeaseResult>;
      releaseLease(
        leaseId: string,
        outcome: { failureClass: FailureClass | null; retryAfterSeconds: number | null },
      ): Promise<void>;
    };
    return {
      acquire: () => stub.acquireLease(),
      release: (leaseId, outcome) => stub.releaseLease(leaseId, outcome),
    };
  };
}
