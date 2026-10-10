import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createFetchService } from '../src/fetcher.ts';
import { createServer } from '../src/server.ts';
import { generateKeys, makeToken } from './helpers.ts';

const keys = generateKeys();
let upstream: http.Server;
let executor: http.Server;
let upstreamPort: number;
let executorPort: number;

before(async () => {
  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('upstream-body');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = (upstream.address() as AddressInfo).port;

  executor = createServer({
    publicKey: keys.publicKey,
    maxBytesCap: 1024 * 1024,
    maxInflight: 4,
    fetchService: createFetchService({
      maxBytesCap: 1024 * 1024,
      timeoutMs: 5000,
      maxRedirects: 5,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      isBlockedAddress: () => false,
      allowedPorts: new Set([upstreamPort]),
    }),
  });
  await new Promise<void>((r) => executor.listen(0, '127.0.0.1', r));
  executorPort = (executor.address() as AddressInfo).port;
});

after(() => {
  upstream.closeAllConnections();
  executor.closeAllConnections();
  upstream.close();
  executor.close();
});

async function call(body: string, authorization?: string, method = 'POST') {
  const res = await fetch(`http://127.0.0.1:${executorPort}/`, {
    method,
    headers: authorization ? { authorization } : {},
    body: method === 'POST' ? body : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const payload = () => JSON.stringify({ url: `http://upstream.example:${upstreamPort}/`, maxBytes: 1000 });
const bearer = (body: string, extra: Partial<Parameters<typeof makeToken>[0]> = {}) =>
  `Bearer ${makeToken({ body: Buffer.from(body), privateKey: keys.privateKey, ...extra })}`;

test('returns 401 without a token', async () => {
  const r = await call(payload());
  assert.equal(r.status, 401);
});

test('returns 401 for a token signed by another key', async () => {
  const body = payload();
  const other = generateKeys();
  const r = await call(body, bearer(body, { privateKey: other.privateKey }));
  assert.equal(r.status, 401);
});

test('returns 401 when the body differs from the signed body', async () => {
  const signed = payload();
  const r = await call(JSON.stringify({ url: 'http://elsewhere.example/', maxBytes: 1000 }), bearer(signed));
  assert.equal(r.status, 401);
});

test('returns 401 on replay of the same token', async () => {
  const body = payload();
  const auth = bearer(body);
  assert.equal((await call(body, auth)).status, 200);
  assert.equal((await call(body, auth)).status, 401);
});

test('returns the fetched response as base64 JSON', async () => {
  const body = payload();
  const r = await call(body, bearer(body));
  assert.equal(r.status, 200);
  assert.equal(r.json.kind, 'response');
  assert.equal(r.json.status, 200);
  assert.equal(Buffer.from(r.json.body as string, 'base64').toString(), 'upstream-body');
  assert.equal(r.json.truncated, false);
});

test('reports ssrf blocks as kind=error', async () => {
  const strictServer = createServer({
    publicKey: keys.publicKey,
    maxBytesCap: 1000,
    maxInflight: 1,
    fetchService: createFetchService({ maxBytesCap: 1000, timeoutMs: 1000, maxRedirects: 5 }),
  });
  await new Promise<void>((r) => strictServer.listen(0, '127.0.0.1', r));
  const port = (strictServer.address() as AddressInfo).port;
  const body = JSON.stringify({ url: 'http://169.254.169.254/', maxBytes: 100 });
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { authorization: bearer(body) }, body });
  const json = (await res.json()) as Record<string, unknown>;
  strictServer.close();
  assert.equal(res.status, 200);
  assert.deepEqual({ kind: json.kind, failureClass: json.failureClass }, { kind: 'error', failureClass: 'ssrf_blocked' });
});

test('returns 400 for a valid token over an invalid request', async () => {
  for (const body of ['not json', JSON.stringify({ maxBytes: 5 }), JSON.stringify({ url: 'http://a/', maxBytes: -1 })]) {
    const r = await call(body, bearer(body));
    assert.equal(r.status, 400, body);
  }
});

test('returns 404 for other routes', async () => {
  const r = await call('', undefined, 'GET');
  assert.equal(r.status, 404);
});
