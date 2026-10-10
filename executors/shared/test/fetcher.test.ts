import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { FetchFailure, createFetchService, sanitizeRequestHeaders } from '../src/fetcher.ts';

const base = { maxBytesCap: 1024 * 1024, timeoutMs: 5000, maxRedirects: 5 };
const strict = createFetchService(base);

async function failureOf(promise: Promise<unknown>): Promise<FetchFailure> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof FetchFailure, String(err));
    return err;
  }
  assert.fail('expected FetchFailure');
}

test('blocks forbidden URLs before connecting', async () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://localhost/',
    'http://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://[::ffff:127.0.0.1]/',
    'http://10.0.0.5/',
    'https://example.com:22/',
    'http://example.com:8080/',
    'ftp://example.com/',
    'file:///etc/passwd',
    'http://user:pw@example.com/',
    'not a url',
  ]) {
    const err = await failureOf(strict({ url, maxBytes: 1000, headers: {} }));
    assert.equal(err.failureClass, 'ssrf_blocked', url);
  }
});

test('rejects hostnames resolving to private addresses, including mixed answers', async () => {
  const service = createFetchService({
    ...base,
    resolve: async (host) =>
      host === 'mixed.example' ? [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }],
  });
  for (const host of ['rebind.example', 'mixed.example']) {
    const err = await failureOf(service({ url: `http://${host}/`, maxBytes: 1000, headers: {} }));
    assert.equal(err.failureClass, 'ssrf_blocked', host);
  }
});

test('maps dns failure to network_error', async () => {
  const service = createFetchService({
    ...base,
    resolve: async () => {
      throw new Error('ENOTFOUND');
    },
  });
  const err = await failureOf(service({ url: 'http://nx.example/', maxBytes: 1000, headers: {} }));
  assert.equal(err.failureClass, 'network_error');
});

test('sanitizeRequestHeaders keeps only the allowlist and drops control characters', () => {
  assert.deepEqual(
    sanitizeRequestHeaders({
      'User-Agent': 'ua',
      Cookie: 'secret',
      Authorization: 'Bearer x',
      Host: 'evil',
      Accept: 'text/html',
      Referer: 'bad\r\nx: y',
      'Accept-Language': 'ja\u3042',
    }),
    { 'user-agent': 'ua', accept: 'text/html' },
  );
});

let server: http.Server;
let port: number;
const seen: http.IncomingHttpHeaders[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.headers);
    const url = new URL(req.url ?? '/', 'http://x');
    switch (url.pathname) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'text/html', etag: '"v1"', 'set-cookie': 'a=b', 'x-secret': '1' });
        res.end('hello');
        return;
      case '/gzip':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
        res.end(gzipSync(Buffer.alloc(200_000, 'a')));
        return;
      case '/big':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(Buffer.alloc(5000, 'b'));
        return;
      case '/forbidden':
        res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
        res.end('no');
        return;
      case '/limited':
        res.writeHead(429, { 'retry-after': '120' });
        res.end();
        return;
      case '/r1':
        res.writeHead(302, { location: '/ok' });
        res.end();
        return;
      case '/loop':
        res.writeHead(302, { location: '/loop' });
        res.end();
        return;
      case '/to-private':
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
        res.end();
        return;
      case '/slow':
        setTimeout(() => res.end('late'), 3000);
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

// テスト用: 実在しないホスト名をローカルサーバへ解決させ、ホスト名ではなく検証済みアドレスへ
// 固定して接続していることを同時に確認する。
function lenient(extra: Partial<Parameters<typeof createFetchService>[0]> = {}) {
  return createFetchService({
    ...base,
    resolve: async (host) => (host === 'pinned.example' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.1', family: 4 }]),
    isBlockedAddress: (a) => a !== '127.0.0.1',
    allowedPorts: new Set([port]),
    ...extra,
  });
}

test('connects to the vetted address and returns a header subset', async () => {
  const result = await lenient()({
    url: `http://pinned.example:${port}/ok`,
    maxBytes: 1000,
    headers: { 'user-agent': 'test-ua', cookie: 'nope', accept: 'text/html' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), 'hello');
  assert.equal(result.truncated, false);
  assert.equal(result.contentType, 'text/html');
  assert.deepEqual(result.headers, { 'content-type': 'text/html', etag: '"v1"' });
  const headers = seen.at(-1)!;
  assert.equal(headers.host, `pinned.example:${port}`);
  assert.equal(headers['user-agent'], 'test-ua');
  assert.equal(headers.accept, 'text/html');
  assert.equal(headers.cookie, undefined);
});

test('follows redirects and re-checks each hop', async () => {
  const ok = await lenient()({ url: `http://pinned.example:${port}/r1`, maxBytes: 1000, headers: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.url, `http://pinned.example:${port}/ok`);

  const err = await failureOf(lenient()({ url: `http://pinned.example:${port}/to-private`, maxBytes: 1000, headers: {} }));
  assert.equal(err.failureClass, 'ssrf_blocked');
});

test('stops after 5 redirects', async () => {
  const err = await failureOf(lenient()({ url: `http://pinned.example:${port}/loop`, maxBytes: 1000, headers: {} }));
  assert.equal(err.failureClass, 'network_error');
  assert.match(err.message, /too_many_redirects/);
});

test('truncates at maxBytes and applies the server-side cap', async () => {
  const small = await lenient()({ url: `http://pinned.example:${port}/big`, maxBytes: 1000, headers: {} });
  assert.equal(small.truncated, true);
  assert.equal(small.body.length, 1000);

  const capped = await lenient({ maxBytesCap: 100 })({ url: `http://pinned.example:${port}/big`, maxBytes: 1_000_000, headers: {} });
  assert.equal(capped.truncated, true);
  assert.equal(capped.body.length, 100);
});

test('enforces maxBytes on the decompressed size', async () => {
  const result = await lenient()({ url: `http://pinned.example:${port}/gzip`, maxBytes: 1000, headers: {} });
  assert.equal(result.truncated, true);
  assert.equal(result.body.length, 1000);
  const full = await lenient()({ url: `http://pinned.example:${port}/gzip`, maxBytes: 500_000, headers: {} });
  assert.equal(full.truncated, false);
  assert.equal(full.body.length, 200_000);
});

test('passes through 403 and 429 with relevant headers', async () => {
  const forbidden = await lenient()({ url: `http://pinned.example:${port}/forbidden`, maxBytes: 1000, headers: {} });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers['cf-mitigated'], 'challenge');
  const limited = await lenient()({ url: `http://pinned.example:${port}/limited`, maxBytes: 1000, headers: {} });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '120');
});

test('enforces the total timeout', async () => {
  const err = await failureOf(lenient({ timeoutMs: 300 })({ url: `http://pinned.example:${port}/slow`, maxBytes: 1000, headers: {} }));
  assert.equal(err.failureClass, 'timeout');
});

test('maps connection errors to network_error', async () => {
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
  const closedPort = (closed.address() as AddressInfo).port;
  await new Promise((r) => closed.close(r));
  const service = lenient({ allowedPorts: new Set([closedPort]) });
  const err = await failureOf(service({ url: `http://pinned.example:${closedPort}/`, maxBytes: 1000, headers: {} }));
  assert.equal(err.failureClass, 'network_error');
});

test('does not connect over ipv6 when allowIpv6 is false', async () => {
  const v6Only = createFetchService({
    ...base,
    allowIpv6: false,
    resolve: async () => [{ address: '2606:4700:4700::1111', family: 6 }],
  });
  assert.equal((await failureOf(v6Only({ url: 'https://example.com/', maxBytes: 100, headers: {} }))).failureClass, 'network_error');
  const literal = createFetchService({ ...base, allowIpv6: false });
  assert.equal((await failureOf(literal({ url: 'http://[2606:4700:4700::1111]/', maxBytes: 100, headers: {} }))).failureClass, 'network_error');
});

test('still rejects blocked ipv6 results when allowIpv6 is false', async () => {
  const mixed = createFetchService({
    ...base,
    allowIpv6: false,
    resolve: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: 'fd00::1', family: 6 },
    ],
  });
  assert.equal((await failureOf(mixed({ url: 'https://example.com/', maxBytes: 100, headers: {} }))).failureClass, 'ssrf_blocked');
});
