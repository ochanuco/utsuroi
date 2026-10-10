import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { AuthError, HttpError, NetworkError, RunnerClient } from '../src/client.ts';
import { startFakeWorker, TOKEN_SECRET } from './helpers.ts';
import type { FakeWorker } from './helpers.ts';

const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`../../../test/fixtures/runner-protocol/${name}.json`, import.meta.url), 'utf8'));

let worker: FakeWorker;
before(async () => {
  worker = await startFakeWorker();
});
after(() => worker.close());

function client(overrides: Record<string, unknown> = {}): RunnerClient {
  return new RunnerClient({
    baseUrl: worker.url,
    accessClientId: 'client-id.access',
    accessClientSecret: TOKEN_SECRET,
    resultRetryDelaysMs: [1, 1, 1],
    ...overrides,
  });
}

test('sends access credentials and the protocol header on every call', async () => {
  worker.requests.length = 0;
  const c = client();
  await c.heartbeat(fixture('heartbeat-request'));
  await c.sendResult('job-1', fixture('result-request-response'));
  assert.equal(worker.requests.length, 2);
  for (const r of worker.requests) {
    assert.equal(r.headers['cf-access-client-id'], 'client-id.access');
    assert.equal(r.headers['cf-access-client-secret'], TOKEN_SECRET);
    assert.equal(r.headers['utsuroi-runner-protocol'], '1');
  }
  assert.deepEqual(worker.requests[0]?.body, fixture('heartbeat-request'));
  assert.deepEqual(worker.requests[1]?.body, fixture('result-request-response'));
});

test('lease returns parsed jobs', async () => {
  worker.jobs.push(...fixture('lease-response').jobs);
  const res = await client().lease(fixture('lease-request'));
  assert.equal(res.jobs[0]?.jobId, fixture('lease-response').jobs[0].jobId);
});

test('treats 401, 403 and redirects as auth errors', async () => {
  for (const status of [401, 403, 302]) {
    worker.forceStatus = status;
    await assert.rejects(client().heartbeat(fixture('heartbeat-request')), (e) => e instanceof AuthError && e.status === status);
  }
  worker.forceStatus = null;
});

test('retries results on 5xx and succeeds', async () => {
  worker.resultResponder = (_id, attempt) => (attempt < 3 ? { status: 503 } : { status: 200, body: { accepted: true } });
  assert.deepEqual(await client().sendResult('retry-5xx', fixture('result-request-response')), { accepted: true });
  assert.equal(worker.requests.filter((r) => r.path.includes('retry-5xx')).length, 3);
});

test('gives up after the retry budget', async () => {
  worker.resultResponder = () => ({ status: 500 });
  await assert.rejects(client().sendResult('always-500', fixture('result-request-response')), NetworkError);
  assert.equal(worker.requests.filter((r) => r.path.includes('always-500')).length, 4);
});

test('does not retry 409, 404 and 413', async () => {
  const cases: Array<[number, unknown, unknown]> = [
    [409, { error: { code: 'lease_mismatch', message: 'x' } }, { rejected: 'lease_mismatch' }],
    [409, { error: { code: 'lease_expired', message: 'x' } }, { rejected: 'lease_expired' }],
    [404, {}, { rejected: 'not_found' }],
    [413, {}, { rejected: 'too_large' }],
  ];
  for (const [status, body, expected] of cases) {
    const id = `once-${status}-${JSON.stringify(body).length}`;
    worker.resultResponder = () => ({ status, body });
    assert.deepEqual(await client().sendResult(id, fixture('result-request-response')), expected);
    assert.equal(worker.requests.filter((r) => r.path.includes(id)).length, 1, String(status));
  }
});

test('retries on network errors', async () => {
  const c = client({ baseUrl: 'http://127.0.0.1:1', resultRetryDelaysMs: [1, 1] });
  await assert.rejects(c.sendResult('x', fixture('result-request-response')), NetworkError);
});

test('surfaces unexpected statuses from heartbeat', async () => {
  worker.forceStatus = 500;
  await assert.rejects(client().heartbeat(fixture('heartbeat-request')), (e) => e instanceof HttpError && e.status === 500);
  worker.forceStatus = null;
});
