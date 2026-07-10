/**
 * Fetcher Policy エンジン (SPEC §8, ADR-0005)
 *
 * AllowList / OrderList の不変条件検証と、実際に試行する Fetcher の
 * 順序決定・進行可否判定・試行シーケンス実行を担う純ロジック層。
 */
import type { FetchOutcome, FetcherPolicy, FetcherPolicyEntry } from '../shared/contracts';
import type { FailureClass } from '../shared/types';
import { DEFAULT_PROCEEDABLE_FAILURES, NEVER_PROCEEDABLE_FAILURES } from '../shared/types';

export interface FetcherPolicyValidation {
  valid: boolean;
  errors: string[];
}

/**
 * ADR-0005 の不変条件を検証する。
 * 1. orderList の全 fetcherId が allowList に含まれる。
 * 2. allowList の全要素が orderList にちょうど1回含まれる。
 * 3. allowList は空にできない。
 */
export function validateFetcherPolicy(policy: FetcherPolicy): FetcherPolicyValidation {
  const errors: string[] = [];
  const { allowList, orderList } = policy;

  if (allowList.length === 0) {
    errors.push('allowList must not be empty');
  }

  const allowSet = new Set(allowList);

  if (allowSet.size !== allowList.length) {
    errors.push('allowList must not contain duplicate fetcherId entries');
  }

  for (const entry of orderList) {
    if (!allowSet.has(entry.fetcherId)) {
      errors.push(`orderList contains fetcherId not present in allowList: '${entry.fetcherId}'`);
    }
  }

  const orderCounts = new Map<string, number>();
  for (const entry of orderList) {
    orderCounts.set(entry.fetcherId, (orderCounts.get(entry.fetcherId) ?? 0) + 1);
  }

  for (const fetcherId of allowList) {
    const count = orderCounts.get(fetcherId) ?? 0;
    if (count !== 1) {
      errors.push(
        `allowList fetcherId '${fetcherId}' appears ${count} time(s) in orderList (expected exactly 1)`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 現在の Fetcher の失敗分類から、次候補へ進んでよいかを判定する。
 * NEVER_PROCEEDABLE_FAILURES は proceedOn の指定に関わらず常に false。
 * proceedOn 省略時は DEFAULT_PROCEEDABLE_FAILURES を用いる。
 */
export function shouldProceedToNext(entry: FetcherPolicyEntry, failure: FailureClass): boolean {
  if (NEVER_PROCEEDABLE_FAILURES.includes(failure)) {
    return false;
  }
  const proceedOn = entry.proceedOn ?? DEFAULT_PROCEEDABLE_FAILURES;
  return proceedOn.includes(failure);
}

/** ポリシーが不正な状態で実行しようとした際の専用エラー */
export class FetcherPolicyInvalidError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`FetcherPolicy is invalid: ${errors.join('; ')}`);
    this.name = 'FetcherPolicyInvalidError';
    this.errors = errors;
  }
}

/** 試行上限のデフォルト値 (ADR-0005 Guardrails: Attempt数とコストに上限) */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * 実行直前の再検証 (ADR-0005 不変条件4) と試行上限適用を行い、
 * 実際に試行する FetcherPolicyEntry の並びを返す。
 */
export function planAttempts(
  policy: FetcherPolicy,
  opts?: { maxAttempts?: number }
): FetcherPolicyEntry[] {
  const validation = validateFetcherPolicy(policy);
  if (!validation.valid) {
    throw new FetcherPolicyInvalidError(validation.errors);
  }

  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  return policy.orderList.slice(0, maxAttempts);
}

export interface FetchAttemptRecord {
  fetcherId: string;
  outcome: FetchOutcome;
}

export interface FetchSequenceResult {
  outcome: FetchOutcome;
  attempts: FetchAttemptRecord[];
}

/**
 * OrderList を順に試行する。成功した時点、または shouldProceedToNext が
 * false を返す失敗が発生した時点で停止する。全 attempt の履歴を返すため
 * 実際の試行順が再現可能になる (SPEC §8 / ADR-0005 Consequences)。
 */
export async function runFetchSequence(
  policy: FetcherPolicy,
  executeFetcher: (fetcherId: string) => Promise<FetchOutcome>,
  opts?: { maxAttempts?: number }
): Promise<FetchSequenceResult> {
  const plan = planAttempts(policy, opts);

  if (plan.length === 0) {
    throw new FetcherPolicyInvalidError(['no fetcher attempts available (maxAttempts is 0)']);
  }

  const attempts: FetchAttemptRecord[] = [];
  let lastOutcome: FetchOutcome | undefined;

  for (const entry of plan) {
    const outcome = await executeFetcher(entry.fetcherId);
    attempts.push({ fetcherId: entry.fetcherId, outcome });
    lastOutcome = outcome;

    if (outcome.ok) {
      return { outcome, attempts };
    }

    if (!shouldProceedToNext(entry, outcome.failureClass)) {
      return { outcome, attempts };
    }
  }

  // plan is non-empty, so lastOutcome is always assigned by the loop above.
  return { outcome: lastOutcome as FetchOutcome, attempts };
}
