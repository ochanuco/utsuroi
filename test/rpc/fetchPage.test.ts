import { describe, expect, it, vi } from 'vitest';
import type { FetcherImplementation, FetcherInvocation, FetcherRegistry } from '../../src/fetch';
import type { FetchOutcome } from '../../src/shared/contracts';
import type { Env } from '../../src/shared/env';
import { fetchPage, parseCallers, resolveCaller } from '../../src/rpc/fetchPage';
import type { CallerConfig } from '../../src/rpc/fetchPage';

const env = { USER_AGENT: 'DefaultUA/1.0' } as Env;

function success(body: string | Uint8Array, over: Partial<Extract<FetchOutcome, { ok: true }>> = {}): FetchOutcome {
  return {
    ok: true,
    status: 200,
    notModified: false,
    finalUrl: 'https://example.com/page',
    contentType: 'text/html; charset=utf-8',
    etag: null,
    lastModified: null,
    body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
    durationMs: 1,
    ...over,
  };
}

function fail(failureClass: Extract<FetchOutcome, { ok: false }>['failureClass'], status: number | null): FetchOutcome {
  return { ok: false, failureClass, status, message: 'x', retryAfterSeconds: null };
}

function setup(outcomes: Record<string, FetchOutcome>, fetchers = Object.keys(outcomes)) {
  const calls: Array<{ id: string; inv: FetcherInvocation }> = [];
  const registry: FetcherRegistry = new Map(
    Object.entries(outcomes).map(([id, outcome]): [string, FetcherImplementation] => [
      id,
      async (inv) => {
        calls.push({ id, inv });
        return outcome;
      },
    ]),
  );
  const caller: CallerConfig = { allowedHosts: ['example.com'], fetchers };
  const run = (req: Parameters<typeof fetchPage>[0]) =>
    fetchPage(req, { env, caller, callerName: 'caller-a', registry });
  return { calls, run };
}

describe('fetchPage', () => {
  it('rejects a host outside allowedHosts without calling any fetcher', async () => {
    const { calls, run } = setup({ 'cf-http': success('x') });
    const res = await run({ url: 'https://other.example.org/' });
    expect(res).toMatchObject({ ok: false, status: 0, failureClass: 'ssrf_blocked', fetcherId: null, html: '' });
    expect(calls).toHaveLength(0);
  });

  it('matches allowedHosts case-insensitively but exactly', async () => {
    const { calls, run } = setup({ 'cf-http': success('x') });
    expect((await run({ url: 'https://EXAMPLE.com/' })).ok).toBe(true);
    expect((await run({ url: 'https://sub.example.com/' })).failureClass).toBe('ssrf_blocked');
    expect(calls).toHaveLength(1);
  });

  it('rejects non-http schemes, userinfo and private hosts even when allowlisted', async () => {
    const caller: CallerConfig = { allowedHosts: ['example.com', '127.0.0.1', '169.254.169.254'], fetchers: ['f'] };
    const registry: FetcherRegistry = new Map([['f', vi.fn(async () => success('x'))]]);
    const run = (url: unknown) =>
      fetchPage({ url } as never, { env, caller, callerName: 'c', registry });
    for (const url of ['ftp://example.com/', 'http://127.0.0.1/', 'http://169.254.169.254/latest', 'https://u:p@example.com/', 42]) {
      expect((await run(url)).failureClass).toBe('ssrf_blocked');
    }
    expect(registry.get('f')).not.toHaveBeenCalled();
  });

  it('falls through a 403 to the next fetcher', async () => {
    const { calls, run } = setup({ a: fail('http_403', 403), b: success('<p>ok</p>') });
    const res = await run({ url: 'https://example.com/' });
    expect(res).toMatchObject({ ok: true, status: 200, fetcherId: 'b', html: '<p>ok</p>', bytes: 9 });
    expect(calls.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('falls through proceedable failures and no-response failures', async () => {
    const { calls, run } = setup({ a: fail('http_5xx', 503), b: fail('internal_error', null), c: success('ok') });
    const res = await run({ url: 'https://example.com/' });
    expect(res.fetcherId).toBe('c');
    expect(calls).toHaveLength(3);
  });

  it('stops at a non-proceedable HTTP failure', async () => {
    const { calls, run } = setup({ a: fail('not_found', 404), b: success('ok') });
    const res = await run({ url: 'https://example.com/' });
    expect(res).toMatchObject({ ok: false, status: 404, failureClass: 'not_found', fetcherId: 'a' });
    expect(calls.map((c) => c.id)).toEqual(['a']);
  });

  it('returns the last HTTP status and failure class when every fetcher fails', async () => {
    const { run } = setup({ a: fail('http_403', 403), b: fail('network_error', null) });
    const res = await run({ url: 'https://example.com/' });
    expect(res).toMatchObject({ ok: false, status: 403, failureClass: 'network_error', fetcherId: 'b' });
  });

  it('truncates to maxBytes, defaulting to 2 MiB and capping at 5 MiB', async () => {
    const big = new Uint8Array(6 * 1024 * 1024).fill(97);
    const { run } = setup({ a: success(big) });
    const small = await run({ url: 'https://example.com/', maxBytes: 10 });
    expect(small).toMatchObject({ truncated: true, bytes: 10, html: 'aaaaaaaaaa' });
    const dflt = await run({ url: 'https://example.com/' });
    expect(dflt).toMatchObject({ truncated: true, bytes: 2 * 1024 * 1024 });
    const capped = await run({ url: 'https://example.com/', maxBytes: 100 * 1024 * 1024 });
    expect(capped).toMatchObject({ truncated: true, bytes: 5 * 1024 * 1024 });
    const bogus = await run({ url: 'https://example.com/', maxBytes: -1 });
    expect(bogus.bytes).toBe(2 * 1024 * 1024);
  });

  it('forwards only allowlisted headers', async () => {
    const { calls, run } = setup({ a: success('x') });
    await run({
      url: 'https://example.com/',
      headers: {
        'User-Agent': 'Custom/1',
        Accept: 'text/html',
        'accept-language': 'en',
        Referer: 'https://example.com/r',
        Cookie: 'secret=1',
        Authorization: 'Bearer x',
        'x-evil': 'y',
      },
    });
    const inv = calls[0]!.inv;
    expect(inv.userAgent).toBe('Custom/1');
    expect(inv.headers).toEqual({ accept: 'text/html', 'accept-language': 'en', referer: 'https://example.com/r' });
  });

  it('uses the default user agent and drops header values with line breaks', async () => {
    const { calls, run } = setup({ a: success('x') });
    await run({ url: 'https://example.com/', headers: { accept: 'a\r\nX: y' } });
    expect(calls[0]!.inv.userAgent).toBe('DefaultUA/1.0');
    expect(calls[0]!.inv.headers).toEqual({});
  });

  it('blocks a final URL outside allowedHosts', async () => {
    const { run } = setup({ a: success('secret', { finalUrl: 'https://other.example.org/x' }) });
    const res = await run({ url: 'https://example.com/' });
    expect(res).toMatchObject({ ok: false, failureClass: 'ssrf_blocked', html: '', fetcherId: null });
  });

  it('hands fetchers a guard that rejects redirect hops outside allowedHosts', async () => {
    const { calls, run } = setup({ a: success('x') });
    await run({ url: 'https://example.com/' });
    const guard = calls[0]!.inv.urlGuard;
    expect(guard('https://example.com/next').allowed).toBe(true);
    expect(guard('https://other.example.org/').allowed).toBe(false);
    expect(guard('http://127.0.0.1/').allowed).toBe(false);
  });

  it('decodes the charset from content-type', async () => {
    const sjis = new Uint8Array([0x82, 0xa0]);
    const { run } = setup({ a: success(sjis, { contentType: 'text/html; charset=shift_jis' }) });
    expect((await run({ url: 'https://example.com/' })).html).toBe('あ');
    const { run: run2 } = setup({ a: success(sjis, { contentType: 'text/html; charset=bogus-charset' }) });
    expect((await run2({ url: 'https://example.com/' })).html).toContain('�');
  });

  it('reports ok=false for non-2xx responses surfaced by a fetcher', async () => {
    const { run } = setup({ a: fail('http_429', 429) });
    expect(await run({ url: 'https://example.com/' })).toMatchObject({ ok: false, status: 429, failureClass: 'http_429' });
  });

  it('logs one structured line without the full URL', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { run } = setup({ a: success('x') });
    await run({ url: 'https://example.com/p?token=abc' });
    const lines = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      event: 'rpc_fetch', caller: 'caller-a', host: 'example.com', fetcherId: 'a', status: 200, failureClass: null,
    });
    expect(lines[0]).not.toContain('token');
  });
});

describe('caller config', () => {
  it('parses valid config and drops malformed entries', () => {
    const map = parseCallers(
      JSON.stringify({ ok: { allowedHosts: [' Example.com '], fetchers: ['cf-http'] }, bad: { allowedHosts: 'x' }, worse: 1 }),
    );
    expect([...map.keys()]).toEqual(['ok']);
    expect(map.get('ok')?.allowedHosts).toEqual(['example.com']);
  });

  it('treats invalid JSON as no callers and logs once', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseCallers('{nope-unique').size).toBe(0);
    expect(parseCallers('{nope-unique').size).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('rejects missing, non-string and unregistered callers', () => {
    const e = { RPC_CALLERS: JSON.stringify({ a: { allowedHosts: [], fetchers: [] } }) } as Env;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const c of [undefined, 42, '', 'nobody']) expect(() => resolveCaller(c, e)).toThrow();
    expect(() => resolveCaller('a', e)).not.toThrow();
    expect(() => resolveCaller('a', {} as Env)).toThrow();
    spy.mockRestore();
  });
});
