import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_ATTEMPTS,
  FetcherPolicyInvalidError,
  planAttempts,
  runFetchSequence,
  shouldProceedToNext,
  validateFetcherPolicy,
} from '../../src/fetch/policy';
import type { FetchOutcome, FetcherPolicy, FetcherPolicyEntry } from '../../src/shared/contracts';
import type { FailureClass } from '../../src/shared/types';

function makeSuccess(overrides: Partial<Extract<FetchOutcome, { ok: true }>> = {}): FetchOutcome {
  return {
    ok: true,
    status: 200,
    notModified: false,
    finalUrl: 'https://example.com/',
    contentType: 'text/html',
    etag: null,
    lastModified: null,
    body: new Uint8Array(),
    durationMs: 1,
    ...overrides,
  };
}

function makeFailure(failureClass: FailureClass, overrides: Partial<Extract<FetchOutcome, { ok: false }>> = {}): FetchOutcome {
  return {
    ok: false,
    failureClass,
    status: null,
    message: `simulated ${failureClass}`,
    retryAfterSeconds: null,
    ...overrides,
  };
}

describe('validateFetcherPolicy', () => {
  it('accepts a well-formed policy', () => {
    const policy: FetcherPolicy = {
      allowList: ['cf-http-apac', 'home-browser'],
      orderList: [{ fetcherId: 'cf-http-apac' }, { fetcherId: 'home-browser' }],
    };
    const result = validateFetcherPolicy(policy);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('rejects when orderList references a fetcherId missing from allowList (invariant 1)', () => {
    const policy: FetcherPolicy = {
      allowList: ['cf-http-apac'],
      orderList: [{ fetcherId: 'cf-http-apac' }, { fetcherId: 'ghost-fetcher' }],
    };
    const result = validateFetcherPolicy(policy);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('ghost-fetcher'))).toBe(true);
  });

  it('rejects when an allowList entry is missing from orderList (invariant 2)', () => {
    const policy: FetcherPolicy = {
      allowList: ['cf-http-apac', 'home-browser'],
      orderList: [{ fetcherId: 'cf-http-apac' }],
    };
    const result = validateFetcherPolicy(policy);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('home-browser'))).toBe(true);
  });

  it('rejects when an allowList entry appears more than once in orderList (invariant 2)', () => {
    const policy: FetcherPolicy = {
      allowList: ['cf-http-apac'],
      orderList: [{ fetcherId: 'cf-http-apac' }, { fetcherId: 'cf-http-apac' }],
    };
    const result = validateFetcherPolicy(policy);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('2 time'))).toBe(true);
  });

  it('rejects an empty allowList (invariant 3)', () => {
    const policy: FetcherPolicy = { allowList: [], orderList: [] };
    const result = validateFetcherPolicy(policy);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('allowList must not be empty'))).toBe(true);
  });

  it('reports multiple violations simultaneously', () => {
    const policy: FetcherPolicy = {
      allowList: [],
      orderList: [{ fetcherId: 'orphan' }],
    };
    const result = validateFetcherPolicy(policy);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('shouldProceedToNext', () => {
  it('never proceeds for NEVER_PROCEEDABLE_FAILURES regardless of proceedOn', () => {
    const entry: FetcherPolicyEntry = { fetcherId: 'x', proceedOn: ['not_found', 'network_error'] };
    expect(shouldProceedToNext(entry, 'not_found')).toBe(false);
    expect(shouldProceedToNext(entry, 'blocked_by_robots')).toBe(false);
    expect(shouldProceedToNext(entry, 'ssrf_blocked')).toBe(false);
    expect(shouldProceedToNext(entry, 'auth_required')).toBe(false);
    expect(shouldProceedToNext(entry, 'too_large')).toBe(false);
    expect(shouldProceedToNext(entry, 'captcha_challenge')).toBe(false);
  });

  it('uses DEFAULT_PROCEEDABLE_FAILURES when proceedOn is omitted', () => {
    const entry: FetcherPolicyEntry = { fetcherId: 'x' };
    expect(shouldProceedToNext(entry, 'network_error')).toBe(true);
    expect(shouldProceedToNext(entry, 'timeout')).toBe(true);
    expect(shouldProceedToNext(entry, 'http_5xx')).toBe(true);
    expect(shouldProceedToNext(entry, 'http_429')).toBe(false);
    expect(shouldProceedToNext(entry, 'http_403')).toBe(false);
  });

  it('honors a custom proceedOn for non-NEVER classes', () => {
    const entry: FetcherPolicyEntry = { fetcherId: 'x', proceedOn: ['http_429', 'http_403'] };
    expect(shouldProceedToNext(entry, 'http_429')).toBe(true);
    expect(shouldProceedToNext(entry, 'http_403')).toBe(true);
    // not in custom list and not a default => false
    expect(shouldProceedToNext(entry, 'network_error')).toBe(false);
  });
});

describe('planAttempts', () => {
  const policy: FetcherPolicy = {
    allowList: ['a', 'b', 'c', 'd'],
    orderList: [{ fetcherId: 'a' }, { fetcherId: 'b' }, { fetcherId: 'c' }, { fetcherId: 'd' }],
  };

  it('applies the default max attempts (3) when opts is omitted', () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(3);
    const plan = planAttempts(policy);
    expect(plan.map((e) => e.fetcherId)).toEqual(['a', 'b', 'c']);
  });

  it('applies a custom maxAttempts', () => {
    const plan = planAttempts(policy, { maxAttempts: 2 });
    expect(plan.map((e) => e.fetcherId)).toEqual(['a', 'b']);
  });

  it('re-validates immediately before execution and throws a dedicated error on invalid policy', () => {
    const invalid: FetcherPolicy = {
      allowList: ['a'],
      orderList: [{ fetcherId: 'a' }, { fetcherId: 'b' }],
    };
    expect(() => planAttempts(invalid)).toThrow(FetcherPolicyInvalidError);
  });
});

describe('runFetchSequence', () => {
  const policy: FetcherPolicy = {
    allowList: ['a', 'b', 'c'],
    orderList: [{ fetcherId: 'a' }, { fetcherId: 'b' }, { fetcherId: 'c' }],
  };

  it('stops at the first success and records only attempts up to it', async () => {
    const executeFetcher = vi.fn(async (fetcherId: string): Promise<FetchOutcome> => {
      if (fetcherId === 'a') return makeFailure('network_error');
      if (fetcherId === 'b') return makeSuccess({ finalUrl: 'https://example.com/b' });
      throw new Error('should not reach c');
    });

    const result = await runFetchSequence(policy, executeFetcher);
    expect(result.outcome.ok).toBe(true);
    expect(result.attempts.map((a) => a.fetcherId)).toEqual(['a', 'b']);
    expect(executeFetcher).toHaveBeenCalledTimes(2);
  });

  it('stops immediately on a non-proceedable failure', async () => {
    const executeFetcher = vi.fn(async (fetcherId: string): Promise<FetchOutcome> => {
      if (fetcherId === 'a') return makeFailure('not_found');
      throw new Error('should not reach b');
    });

    const result = await runFetchSequence(policy, executeFetcher);
    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) {
      expect(result.outcome.failureClass).toBe('not_found');
    }
    expect(result.attempts.map((a) => a.fetcherId)).toEqual(['a']);
  });

  it('continues past a proceedable failure and reports full attempt history', async () => {
    const executeFetcher = vi.fn(async (fetcherId: string): Promise<FetchOutcome> => {
      if (fetcherId === 'a') return makeFailure('timeout');
      if (fetcherId === 'b') return makeFailure('http_5xx');
      return makeFailure('not_found');
    });

    const result = await runFetchSequence(policy, executeFetcher);
    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) {
      expect(result.outcome.failureClass).toBe('not_found');
    }
    expect(result.attempts.map((a) => a.fetcherId)).toEqual(['a', 'b', 'c']);
  });

  it('caps attempts at maxAttempts even if every failure would otherwise proceed', async () => {
    const executeFetcher = vi.fn(async (): Promise<FetchOutcome> => makeFailure('network_error'));

    const result = await runFetchSequence(policy, executeFetcher, { maxAttempts: 2 });
    expect(result.attempts.map((a) => a.fetcherId)).toEqual(['a', 'b']);
    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) {
      expect(result.outcome.failureClass).toBe('network_error');
    }
    expect(executeFetcher).toHaveBeenCalledTimes(2);
  });

  it('throws before attempting anything if the policy is invalid', async () => {
    const invalid: FetcherPolicy = {
      allowList: ['a', 'b'],
      orderList: [{ fetcherId: 'a' }],
    };
    const executeFetcher = vi.fn(async (): Promise<FetchOutcome> => makeSuccess());
    await expect(runFetchSequence(invalid, executeFetcher)).rejects.toThrow(FetcherPolicyInvalidError);
    expect(executeFetcher).not.toHaveBeenCalled();
  });
});
