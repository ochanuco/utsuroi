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
  /**
   * half-open (circuitOpenUntil 経過後、まだ成否が確定していない) 状態で発行中の
   * 単一プローブ lease の id。null は half-open プローブ無し (closed、または未着手)。
   * この値が非null の間は acquireLease が追加のリースを一切許可しない
   * (「半開状態では単一プローブのみ許可」を実装として保証する)。
   */
  halfOpenProbeLeaseId: string | null;
}

function emptyState(): HostState {
  return {
    activeLeases: {},
    lastAcquireAt: null,
    nextAllowedAt: null,
    failureStreak: 0,
    circuitOpenUntil: null,
    halfOpenProbeLeaseId: null,
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
    // Partial で読む: 既存デプロイの永続化済み state に halfOpenProbeLeaseId フィールドが
    // 無いケース (このフィールド追加前に保存された state) への防御。emptyState() の既定値と
    // マージすることで、フィールド欠落時も安全な (null = half-open プローブ無し) 値になる。
    const stored = await this.ctx.storage.get<Partial<HostState>>('state');
    if (!stored) return emptyState();
    return { ...emptyState(), ...stored };
  }

  private async saveState(state: HostState): Promise<void> {
    await this.ctx.storage.put('state', state);
  }

  private expireStaleLeases(state: HostState, now: number): void {
    for (const [leaseId, grantedAt] of Object.entries(state.activeLeases)) {
      if (now - grantedAt >= LEASE_TTL_MS) {
        delete state.activeLeases[leaseId];
        // リークした (release() を呼ばずに終わった) プローブ lease が half-open 状態を
        // 永久にブロックしないよう、期限切れと同時にプローブ枠も解放する。
        if (state.halfOpenProbeLeaseId === leaseId) {
          state.halfOpenProbeLeaseId = null;
        }
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
      // breaker window elapsed: half-open。単一プローブのみ許可する。既にプローブが
      // 発行済み (未解決) であれば、通常の同時実行数枠とは無関係に追加の acquire を拒否する。
      if (state.halfOpenProbeLeaseId !== null) {
        await this.saveState(state);
        return { granted: false, leaseId: null, retryAfterMs: MIN_ACCESS_INTERVAL_MS };
      }
      const leaseId = crypto.randomUUID();
      state.activeLeases[leaseId] = now;
      state.lastAcquireAt = now;
      state.halfOpenProbeLeaseId = leaseId;
      // circuitOpenUntil はプローブの成否 (releaseLease) が確定するまで維持しない: プローブが
      // 発行された時点で「open ウィンドウは終わった」とみなし、以降の acquire は
      // halfOpenProbeLeaseId の有無だけで制御する (プローブ失敗時は releaseLease が
      // 新しい circuitOpenUntil を設定して re-open する)。
      state.circuitOpenUntil = null;
      await this.saveState(state);
      return { granted: true, leaseId, retryAfterMs: null };
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
    if (state.halfOpenProbeLeaseId === leaseId) {
      // プローブの成否が確定した: half-open 状態を終了する (成功なら closed へ、
      // 失敗なら下の failureStreak 更新により再度 circuitOpenUntil が設定され open へ戻る)。
      state.halfOpenProbeLeaseId = null;
    }

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
