import { SELF } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Stub = { fetchPage(req: { url: string; maxBytes?: number; headers?: Record<string, string> }): Promise<Record<string, unknown>> };

const entrypoint = exports as unknown as { FetchEntrypoint(opts: { props?: unknown }): Stub };
const stub = (props?: unknown): Stub => entrypoint.FetchEntrypoint({ props });

afterEach(() => vi.restoreAllMocks());

describe('FetchEntrypoint over a service binding', () => {
  it('fetches an allowed page through cf-http and forwards allowlisted headers only', async () => {
    const seen: Headers[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers));
      return new Response('<h1>hi</h1>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch);
    const res = await stub({ caller: 'caller-a' }).fetchPage({
      url: 'https://example.com/page',
      headers: { accept: 'text/html', cookie: 'a=b' },
    });
    expect(res).toMatchObject({ ok: true, status: 200, html: '<h1>hi</h1>', fetcherId: 'cf-http', bytes: 11 });
    expect(seen[0]!.get('accept')).toBe('text/html');
    expect(seen[0]!.get('cookie')).toBeNull();
  });

  it('rejects a missing or unregistered caller', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    for (const props of [undefined, { caller: 7 }, { caller: 'nobody' }]) {
      let error: unknown;
      try {
        await stub(props).fetchPage({ url: 'https://example.com/' });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(Error);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns ssrf_blocked for hosts outside the allowlist and for private addresses', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const a = stub({ caller: 'caller-a' });
    expect(await a.fetchPage({ url: 'https://other.example.org/' })).toMatchObject({ failureClass: 'ssrf_blocked' });
    expect(await a.fetchPage({ url: 'http://127.0.0.1/' })).toMatchObject({ failureClass: 'ssrf_blocked' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('blocks a redirect to a host outside the allowlist', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      new Response(null, { status: 302, headers: { location: 'https://other.example.org/' } })) as unknown as typeof fetch);
    const res = await stub({ caller: 'caller-b' }).fetchPage({ url: 'https://example.com/' });
    expect(res).toMatchObject({ ok: false, failureClass: 'ssrf_blocked', html: '' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not expose the public fetch handler to RPC callers', async () => {
    const res = await SELF.fetch('https://example.com/api/sites');
    expect(res.status).not.toBe(200);
  });
});
