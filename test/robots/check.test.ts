import { describe, expect, it, vi } from 'vitest';
import { checkRobots } from '../../src/robots/check';
import type { CachedRobots, RobotsCache } from '../../src/robots/types';

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

class MemoryCache implements RobotsCache {
  store = new Map<string, CachedRobots>();
  async get(origin: string) {
    return this.store.get(origin) ?? null;
  }
  async put(origin: string, value: CachedRobots) {
    this.store.set(origin, value);
  }
}

describe('checkRobots', () => {
  it('fetches robots.txt from ${origin}/robots.txt and evaluates the target URL', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://example.com/robots.txt');
      return textResponse(200, ['User-agent: *', 'Disallow: /private'].join('\n'));
    });

    const decision = await checkRobots('https://example.com', 'https://example.com/private/x', { fetchImpl });
    expect(decision.verdict).toBe('disallowed');
    expect(decision.robotsUrl).toBe('https://example.com/robots.txt');
    expect(decision.userAgentGroup).toBe('*');
    expect(decision.matchedRule).toBe('disallow: /private');
    expect(decision.unavailable).toBe(false);
    expect(decision.fromCache).toBe(false);
  });

  it('treats 4xx (401/403/404) as fully allowed per RFC 9309', async () => {
    for (const status of [401, 403, 404]) {
      const fetchImpl = vi.fn(async () => textResponse(status, ''));
      const decision = await checkRobots('https://example.com', 'https://example.com/anything', { fetchImpl });
      expect(decision.verdict).toBe('allowed');
      expect(decision.unavailable).toBe(false);
    }
  });

  it('treats 5xx as unavailable and disallowed per RFC 9309', async () => {
    const fetchImpl = vi.fn(async () => textResponse(503, ''));
    const decision = await checkRobots('https://example.com', 'https://example.com/anything', { fetchImpl });
    expect(decision.verdict).toBe('disallowed');
    expect(decision.unavailable).toBe(true);
    expect(decision.userAgentGroup).toBe('unavailable');
  });

  it('treats network errors as unavailable and disallowed', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const decision = await checkRobots('https://example.com', 'https://example.com/anything', { fetchImpl });
    expect(decision.verdict).toBe('disallowed');
    expect(decision.unavailable).toBe(true);
  });

  it('caps robots.txt body reading at 500 KiB and ignores the remainder', async () => {
    const huge = 'User-agent: *\n'.padEnd(600 * 1024, ' ') + '\nDisallow: /should-be-ignored\n';
    const fetchImpl = vi.fn(async () => textResponse(200, huge));
    const decision = await checkRobots('https://example.com', 'https://example.com/should-be-ignored', {
      fetchImpl,
    });
    // The Disallow line beyond the 500KiB cap must never be parsed.
    expect(decision.verdict).toBe('allowed');
  });

  it('uses the cache within TTL and refetches after expiry', async () => {
    const fetchImpl = vi.fn(async () => textResponse(200, ['User-agent: *', 'Disallow: /x'].join('\n')));
    const cache = new MemoryCache();
    let nowMs = 1_000_000;
    const now = () => nowMs;

    const first = await checkRobots('https://example.com', 'https://example.com/x', {
      fetchImpl,
      cache,
      ttlSeconds: 100,
      now,
    });
    expect(first.fromCache).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    nowMs += 50 * 1000; // within TTL
    const second = await checkRobots('https://example.com', 'https://example.com/x', {
      fetchImpl,
      cache,
      ttlSeconds: 100,
      now,
    });
    expect(second.fromCache).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    nowMs += 100 * 1000; // now well past TTL
    const third = await checkRobots('https://example.com', 'https://example.com/x', {
      fetchImpl,
      cache,
      ttlSeconds: 100,
      now,
    });
    expect(third.fromCache).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('bounds the robots.txt fetch with a timeout and treats an aborted fetch as unavailable/disallowed', async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );

    const decision = await checkRobots('https://example.com', 'https://example.com/anything', {
      fetchImpl,
      timeoutMs: 50,
    });
    expect(decision.unavailable).toBe(true);
    expect(decision.verdict).toBe('disallowed');
    expect(decision.userAgentGroup).toBe('unavailable');
  });

  it('treats a 2xx response whose body read/parse throws as unavailable rather than rejecting', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('User-agent: *\n'));
        controller.error(new Error('simulated stream failure'));
      },
    });
    const response = new Response(stream, { status: 200 });
    const fetchImpl = vi.fn(async () => response);

    await expect(
      checkRobots('https://example.com', 'https://example.com/anything', { fetchImpl }),
    ).resolves.toMatchObject({ unavailable: true, verdict: 'disallowed' });
  });

  it('does not treat a Sitemap directive as blanket allow end-to-end', async () => {
    const fetchImpl = vi.fn(async () =>
      textResponse(200, ['User-agent: *', 'Disallow: /', 'Sitemap: https://example.com/sitemap.xml'].join('\n')),
    );
    const decision = await checkRobots('https://example.com', 'https://example.com/page', { fetchImpl });
    expect(decision.verdict).toBe('disallowed');
  });
});
