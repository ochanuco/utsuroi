import { describe, expect, it } from 'vitest';
import { defaultFetcherRegistry, runFetcher } from '../../src/fetch/registry';
import type { FetcherImplementation, FetcherInvocation, FetcherRegistry } from '../../src/fetch/registry';
import { checkUrlForSsrf } from '../../src/net';
import type { Env } from '../../src/shared/env';

function invocation(fetchImpl?: typeof fetch): FetcherInvocation {
  return {
    url: 'https://example.com/page',
    userAgent: 'TestUA/1.0',
    etag: null,
    lastModified: null,
    env: {} as Env,
    fetchImpl,
    urlGuard: checkUrlForSsrf,
  };
}

describe('fetcher registry', () => {
  it('registers cf-http and gcp-http', () => {
    expect([...defaultFetcherRegistry.keys()].sort()).toEqual(['cf-http', 'gcp-http']);
  });

  it('runs cf-http through httpFetch with the same request shape', async () => {
    let seenUrl = '';
    let seenHeaders: Headers | undefined;
    const outcome = await runFetcher(
      defaultFetcherRegistry,
      'cf-http',
      invocation((async (url: string, init: RequestInit) => {
        seenUrl = url;
        seenHeaders = new Headers(init.headers);
        return new Response('hi', { status: 200, headers: { 'content-type': 'text/plain' } });
      }) as unknown as typeof fetch),
    );
    expect(outcome.ok).toBe(true);
    expect(seenUrl).toBe('https://example.com/page');
    expect(seenHeaders?.get('user-agent')).toBe('TestUA/1.0');
  });

  it('returns internal_error for unknown fetcher ids', async () => {
    const outcome = await runFetcher(defaultFetcherRegistry, 'home-http', invocation());
    expect(outcome).toMatchObject({ ok: false, failureClass: 'internal_error', message: 'unknown fetcherId: home-http' });
  });

  it('converts a throwing implementation into internal_error', async () => {
    const impl: FetcherImplementation = async () => {
      throw new Error('kaboom');
    };
    const registry: FetcherRegistry = new Map([['custom', impl]]);
    const outcome = await runFetcher(registry, 'custom', invocation());
    expect(outcome).toMatchObject({ ok: false, failureClass: 'internal_error' });
    expect(!outcome.ok && outcome.message).toContain('kaboom');
  });

  it('accepts an arbitrary async implementation (pull-style fetchers plug in the same way)', async () => {
    const impl: FetcherImplementation = async (inv) => ({
      ok: true,
      status: 200,
      notModified: false,
      finalUrl: inv.url,
      contentType: 'text/plain',
      etag: null,
      lastModified: null,
      body: new Uint8Array(),
      durationMs: 1,
    });
    const outcome = await runFetcher(new Map([['home-http', impl]]), 'home-http', invocation());
    expect(outcome.ok).toBe(true);
  });
});
