import { describe, expect, it } from 'vitest';
import { gcpHttpFetch } from '../../src/fetch/gcpHttp';
import type { FetcherInvocation } from '../../src/fetch/registry';
import { checkUrlForSsrf } from '../../src/net';
import type { Env } from '../../src/shared/env';

function toPem(label: string, der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
}

const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const SIGNING_KEY = toPem('PRIVATE KEY', (await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)) as ArrayBuffer);
const EXECUTOR_URL = 'https://executor.example.test/';

function b64urlDecode(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

interface Captured {
  url: string;
  init: RequestInit;
  json: { url: string; maxBytes: number; headers: Record<string, string> };
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signatureValid: boolean;
  bodyHashMatches: boolean;
}

async function capture(url: string | URL | Request, init: RequestInit | undefined): Promise<Captured> {
  const bodyBytes = init!.body as Uint8Array;
  const auth = new Headers(init!.headers).get('authorization')!;
  const [h, p, s] = auth.slice('Bearer '.length).split('.') as [string, string, string];
  const signatureValid = await crypto.subtle.verify(
    { name: 'Ed25519' },
    keyPair.publicKey,
    b64urlDecode(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bodyBytes));
  return {
    url: String(url),
    init: init!,
    json: JSON.parse(new TextDecoder().decode(bodyBytes)),
    header: JSON.parse(new TextDecoder().decode(b64urlDecode(h))),
    claims,
    signatureValid,
    bodyHashMatches: claims.bh === toB64(digest).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''),
  };
}

function executorResponse(over: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      kind: 'response',
      status: 200,
      url: 'https://example.com/page',
      contentType: 'text/html',
      headers: { 'content-type': 'text/html', etag: '"v1"' },
      body: btoa('hello'),
      truncated: false,
      durationMs: 12,
      ...over,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function invocation(opts: { env?: Partial<Env>; fetchImpl: typeof fetch; url?: string }): FetcherInvocation {
  return {
    url: opts.url ?? 'https://example.com/page',
    userAgent: 'TestUA/1.0',
    etag: null,
    lastModified: null,
    env: { GCP_EXECUTOR_URL: EXECUTOR_URL, GCP_EXECUTOR_SIGNING_KEY: SIGNING_KEY, ...opts.env } as Env,
    fetchImpl: opts.fetchImpl,
    urlGuard: checkUrlForSsrf,
  };
}

const respond = (res: Response | (() => Response)): typeof fetch =>
  (async () => (typeof res === 'function' ? res() : res)) as unknown as typeof fetch;

describe('gcpHttpFetch: configuration', () => {
  it('returns internal_error without calling out when GCP_EXECUTOR_URL is empty', async () => {
    let called = false;
    const outcome = await gcpHttpFetch(
      invocation({
        env: { GCP_EXECUTOR_URL: '' },
        fetchImpl: (async () => {
          called = true;
          return executorResponse();
        }) as unknown as typeof fetch,
      }),
    );
    expect(called).toBe(false);
    expect(outcome).toMatchObject({ ok: false, failureClass: 'internal_error' });
    expect(!outcome.ok && outcome.message).toContain('GCP_EXECUTOR_URL');
  });

  it('returns internal_error when the signing key is missing or invalid, never throws', async () => {
    const missing = await gcpHttpFetch(invocation({ env: { GCP_EXECUTOR_SIGNING_KEY: undefined }, fetchImpl: respond(executorResponse()) }));
    expect(missing).toMatchObject({ ok: false, failureClass: 'internal_error' });
    const invalid = await gcpHttpFetch(
      invocation({ env: { GCP_EXECUTOR_SIGNING_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' }, fetchImpl: respond(executorResponse()) }),
    );
    expect(invalid).toMatchObject({ ok: false, failureClass: 'internal_error' });
  });

  it('rejects a non-https executor url', async () => {
    const outcome = await gcpHttpFetch(invocation({ env: { GCP_EXECUTOR_URL: 'http://executor.example.test/' }, fetchImpl: respond(executorResponse()) }));
    expect(outcome).toMatchObject({ ok: false, failureClass: 'internal_error' });
  });

  it('blocks ssrf targets locally before calling the executor', async () => {
    let called = false;
    const outcome = await gcpHttpFetch(
      invocation({
        url: 'http://169.254.169.254/latest',
        fetchImpl: (async () => {
          called = true;
          return executorResponse();
        }) as unknown as typeof fetch,
      }),
    );
    expect(called).toBe(false);
    expect(outcome).toMatchObject({ ok: false, failureClass: 'ssrf_blocked' });
  });
});

describe('gcpHttpFetch: request', () => {
  it('posts a JWT-authenticated JSON body bound to its hash (real Ed25519 WebCrypto)', async () => {
    let captured: Captured | undefined;
    const inv = invocation({
      fetchImpl: (async (url: string, init: RequestInit) => {
        captured = await capture(url, init);
        return executorResponse();
      }) as unknown as typeof fetch,
    });
    inv.etag = '"abc"';
    inv.lastModified = 'Wed, 01 Jan 2026 00:00:00 GMT';
    await gcpHttpFetch(inv);

    expect(captured).toBeDefined();
    const c = captured!;
    expect(c.url).toBe(EXECUTOR_URL);
    expect(c.init.method).toBe('POST');
    expect(c.init.redirect).toBe('manual');
    expect(c.header).toEqual({ alg: 'EdDSA', typ: 'JWT' });
    expect(c.signatureValid).toBe(true);
    expect(c.bodyHashMatches).toBe(true);
    expect(c.claims).toMatchObject({ iss: 'utsuroi', aud: 'gcp-http' });
    const iat = c.claims.iat as number;
    const exp = c.claims.exp as number;
    expect(exp - iat).toBeLessThanOrEqual(60);
    expect(Math.abs(iat - Date.now() / 1000)).toBeLessThan(5);
    expect(typeof c.claims.jti).toBe('string');
    expect(c.json.url).toBe('https://example.com/page');
    expect(c.json.maxBytes).toBe(5 * 1024 * 1024);
    expect(c.json.headers['user-agent']).toBe('TestUA/1.0');
    expect(c.json.headers['if-none-match']).toBe('"abc"');
    expect(c.json.headers['if-modified-since']).toBe('Wed, 01 Jan 2026 00:00:00 GMT');
  });

  it('uses a fresh jti for every request', async () => {
    const jtis: unknown[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      jtis.push((await capture(url, init)).claims.jti);
      return executorResponse();
    }) as unknown as typeof fetch;
    await gcpHttpFetch(invocation({ fetchImpl }));
    await gcpHttpFetch(invocation({ fetchImpl }));
    expect(new Set(jtis).size).toBe(2);
  });
});

describe('gcpHttpFetch: response mapping (consistent with cf-http)', () => {
  it('maps a 200 to a success with the decoded body', async () => {
    const outcome = await gcpHttpFetch(invocation({ fetchImpl: respond(() => executorResponse()) }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe(200);
    expect(outcome.finalUrl).toBe('https://example.com/page');
    expect(outcome.contentType).toBe('text/html');
    expect(outcome.etag).toBe('"v1"');
    expect(new TextDecoder().decode(outcome.body!)).toBe('hello');
  });

  it('maps 304 to notModified', async () => {
    const outcome = await gcpHttpFetch(invocation({ fetchImpl: respond(() => executorResponse({ status: 304, body: '' })) }));
    expect(outcome).toMatchObject({ ok: true, status: 304, notModified: true });
  });

  const cases: Array<[string, Record<string, unknown>, string, number | null]> = [
    ['403', { status: 403, body: btoa('nope') }, 'http_403', null],
    ['403 with bot challenge header', { status: 403, headers: { 'cf-mitigated': 'challenge' } }, 'captcha_challenge', null],
    ['404', { status: 404, body: '' }, 'not_found', null],
    ['401', { status: 401, body: '' }, 'auth_required', null],
    ['429 with retry-after', { status: 429, headers: { 'retry-after': '120' }, body: '' }, 'http_429', 120],
    ['503', { status: 503, body: '' }, 'http_5xx', null],
  ];
  for (const [name, over, failureClass, retryAfter] of cases) {
    it(`maps upstream ${name} to ${failureClass}`, async () => {
      const outcome = await gcpHttpFetch(invocation({ fetchImpl: respond(() => executorResponse(over)) }));
      expect(outcome).toMatchObject({ ok: false, failureClass, retryAfterSeconds: retryAfter });
    });
  }

  it('maps a truncated body to too_large', async () => {
    const outcome = await gcpHttpFetch(invocation({ fetchImpl: respond(() => executorResponse({ truncated: true })) }));
    expect(outcome).toMatchObject({ ok: false, failureClass: 'too_large', status: 200 });
  });

  it('maps executor-reported errors', async () => {
    for (const failureClass of ['ssrf_blocked', 'timeout', 'network_error', 'too_large']) {
      const outcome = await gcpHttpFetch(
        invocation({ fetchImpl: respond(() => new Response(JSON.stringify({ kind: 'error', failureClass, message: 'boom' }))) }),
      );
      expect(outcome).toMatchObject({ ok: false, failureClass });
    }
  });

  it('treats unknown executor failure classes as internal_error', async () => {
    const outcome = await gcpHttpFetch(
      invocation({ fetchImpl: respond(() => new Response(JSON.stringify({ kind: 'error', failureClass: 'http_403', message: 'x' }))) }),
    );
    expect(outcome).toMatchObject({ ok: false, failureClass: 'internal_error' });
  });
});

describe('gcpHttpFetch: executor-side failures', () => {
  it('maps auth/validation rejections to internal_error', async () => {
    for (const status of [400, 401, 403, 413, 500]) {
      const outcome = await gcpHttpFetch(invocation({ fetchImpl: respond(() => new Response('{}', { status })) }));
      expect(outcome, String(status)).toMatchObject({ ok: false, failureClass: 'internal_error' });
    }
  });

  it('maps cloud run unavailability to network_error', async () => {
    for (const status of [502, 503, 504]) {
      const outcome = await gcpHttpFetch(invocation({ fetchImpl: respond(() => new Response('', { status })) }));
      expect(outcome, String(status)).toMatchObject({ ok: false, failureClass: 'network_error' });
    }
  });

  it('maps malformed payloads to internal_error', async () => {
    for (const res of [
      () => new Response('not json'),
      () => new Response('[]'),
      () => new Response(JSON.stringify({ kind: 'weird' })),
      () => executorResponse({ status: 99 }),
      () => executorResponse({ body: '***' }),
      () => executorResponse({ headers: 'x' }),
    ]) {
      const outcome = await gcpHttpFetch(invocation({ fetchImpl: respond(res) }));
      expect(outcome).toMatchObject({ ok: false, failureClass: 'internal_error' });
    }
  });

  it('maps transport errors and timeouts', async () => {
    const network = await gcpHttpFetch(invocation({ fetchImpl: (async () => { throw new TypeError('connection reset'); }) as unknown as typeof fetch }));
    expect(network).toMatchObject({ ok: false, failureClass: 'network_error' });
    const timeout = await gcpHttpFetch(
      invocation({ fetchImpl: (async () => { throw new DOMException('timed out', 'TimeoutError'); }) as unknown as typeof fetch }),
    );
    expect(timeout).toMatchObject({ ok: false, failureClass: 'timeout' });
  });
});
