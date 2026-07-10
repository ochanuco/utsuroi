import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  CIRCUIT_BREAKER_THRESHOLD,
  CIRCUIT_OPEN_MS,
  MAX_CONCURRENT_LEASES,
  MIN_ACCESS_INTERVAL_MS,
  type HostObject,
} from '../../src/do/hostObject';

function getStub(origin: string): DurableObjectStub<HostObject> {
  const id = env.HOST_DO.idFromName(origin);
  return env.HOST_DO.get(id) as unknown as DurableObjectStub<HostObject>;
}

async function withClock(stub: DurableObjectStub<HostObject>, atMs: number): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    (instance as HostObject).nowOverride = () => atMs;
  });
}

describe('HostObject (SPEC §11: per-origin rate limit / lease / backoff / circuit breaker)', () => {
  it('enforces the minimum access interval between acquisitions', async () => {
    const stub = getStub('https://interval.example');
    let t = 1_000_000;
    await withClock(stub, t);
    const first = await stub.acquireLease();
    expect(first.granted).toBe(true);
    await stub.releaseLease(first.leaseId!, { failureClass: null, retryAfterSeconds: null });

    t += 1_000; // well within the 10s minimum interval
    await withClock(stub, t);
    const second = await stub.acquireLease();
    expect(second.granted).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);

    t += MIN_ACCESS_INTERVAL_MS; // past the interval
    await withClock(stub, t);
    const third = await stub.acquireLease();
    expect(third.granted).toBe(true);
  });

  it('caps concurrent leases at the configured maximum', async () => {
    const stub = getStub('https://concurrency.example');
    let t = 2_000_000;

    const leaseIds: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT_LEASES; i++) {
      t += MIN_ACCESS_INTERVAL_MS;
      await withClock(stub, t);
      const lease = await stub.acquireLease();
      expect(lease.granted).toBe(true);
      leaseIds.push(lease.leaseId!);
    }

    t += MIN_ACCESS_INTERVAL_MS;
    await withClock(stub, t);
    const overCapacity = await stub.acquireLease();
    expect(overCapacity.granted).toBe(false);

    // releasing one frees a slot back up
    await stub.releaseLease(leaseIds[0]!, { failureClass: null, retryAfterSeconds: null });
    t += MIN_ACCESS_INTERVAL_MS;
    await withClock(stub, t);
    const afterRelease = await stub.acquireLease();
    expect(afterRelease.granted).toBe(true);
  });

  it('applies exponential backoff after failures and opens the circuit breaker at the threshold', async () => {
    const stub = getStub('https://backoff.example');
    let t = 3_000_000;

    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
      // advance far beyond any single backoff step before each subsequent attempt, so this
      // loop exercises the breaker threshold rather than getting blocked by the backoff wait.
      if (i > 0) t += 10 * 60_000;
      await withClock(stub, t);
      const lease = await stub.acquireLease();
      expect(lease.granted).toBe(true);
      await stub.releaseLease(lease.leaseId!, { failureClass: 'http_5xx', retryAfterSeconds: null });
    }

    // check immediately (same t as the release that tripped the breaker): still well within
    // the CIRCUIT_OPEN_MS window opened by that last release.
    await withClock(stub, t);
    const blocked = await stub.acquireLease();
    expect(blocked.granted).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    t += CIRCUIT_OPEN_MS + 1;
    await withClock(stub, t);
    const afterBreakerWindow = await stub.acquireLease();
    expect(afterBreakerWindow.granted).toBe(true);
  });

  it('a single failure imposes a backoff wait shorter than the circuit breaker', async () => {
    const stub = getStub('https://single-failure.example');
    let t = 3_500_000;
    await withClock(stub, t);
    const lease = await stub.acquireLease();
    expect(lease.granted).toBe(true);
    await stub.releaseLease(lease.leaseId!, { failureClass: 'network_error', retryAfterSeconds: null });

    t += 1_000; // well before the backoff (10s for a single failure) elapses
    await withClock(stub, t);
    const tooSoon = await stub.acquireLease();
    expect(tooSoon.granted).toBe(false);
  });

  it('respects Retry-After on http_429 even when it exceeds the computed backoff', async () => {
    const stub = getStub('https://retryafter.example');
    let t = 4_000_000;
    await withClock(stub, t);
    const lease = await stub.acquireLease();
    expect(lease.granted).toBe(true);
    await stub.releaseLease(lease.leaseId!, { failureClass: 'http_429', retryAfterSeconds: 120 });

    t += 60_000; // 60s later: plain backoff (10s) would allow, Retry-After (120s) should not
    await withClock(stub, t);
    const tooSoon = await stub.acquireLease();
    expect(tooSoon.granted).toBe(false);
    expect(tooSoon.retryAfterMs).toBeGreaterThan(0);

    t += 61_000; // now > 120s since release
    await withClock(stub, t);
    const afterRetryAfter = await stub.acquireLease();
    expect(afterRetryAfter.granted).toBe(true);
  });
});
