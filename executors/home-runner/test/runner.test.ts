import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { createRunnerFetchService } from '../src/addressPolicy.ts';
import { RunnerClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import { createHealthServer } from '../src/health.ts';
import { Runner } from '../src/runner.ts';
import type { RunnerOptions } from '../src/runner.ts';
import { captureLogs, job, permissiveFetchService, startFakeTarget, startFakeWorker, TOKEN_SECRET, waitFor } from './helpers.ts';
import type { FakeTarget, FakeWorker } from './helpers.ts';

const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`../../../test/fixtures/runner-protocol/${name}.json`, import.meta.url), 'utf8'));

let worker: FakeWorker;
let target: FakeTarget;
before(async () => {
  worker = await startFakeWorker();
  target = await startFakeTarget();
});
after(async () => {
  await worker.close();
  await target.close();
});
beforeEach(() => {
  worker.requests.length = 0;
  worker.jobs.length = 0;
  worker.maintenance = false;
  worker.forceStatus = null;
  worker.resultResponder = () => ({ status: 200, body: { accepted: true } });
  target.hits = 0;
});

function makeRunner(overrides: Partial<RunnerOptions> = {}) {
  const logs = captureLogs();
  const runner = new Runner({
    client: new RunnerClient({
      baseUrl: worker.url,
      accessClientId: 'client-id.access',
      accessClientSecret: TOKEN_SECRET,
      resultRetryDelaysMs: [1, 1, 1],
    }),
    createFetchService: permissiveFetchService,
    executorId: 'home',
    concurrency: 2,
    version: 'test',
    fetchTimeoutMs: 20_000,
    leaseWaitMs: 200,
    heartbeatIntervalMs: 100,
    backoffBaseMs: 10,
    backoffMaxMs: 40,
    authBackoffMaxMs: 80,
    logger: logs.logger,
    ...overrides,
  });
  return { runner, logs };
}

const resultsFor = (jobId: string) => worker.requests.filter((r) => r.path === `/api/runner/jobs/${jobId}/result`);

test('leases a job, fetches it and returns the result with the lease token', async () => {
  const { runner } = makeRunner();
  worker.jobs.push(job('j1', target.url));
  runner.start();
  await waitFor(() => resultsFor('j1').length === 1);
  await runner.stop();

  const sent = resultsFor('j1')[0]?.body;
  assert.equal(sent.leaseToken, 'token-j1');
  assert.equal(sent.result.kind, 'response');
  assert.equal(sent.result.status, 200);
  assert.equal(Buffer.from(sent.result.body, 'base64').toString(), 'hello');
  assert.equal(sent.result.truncated, false);
  assert.equal(sent.result.headers.etag, '"v1"');
  assert.equal(typeof sent.result.durationMs, 'number');
  for (const r of worker.requests) assert.equal(r.headers['utsuroi-runner-protocol'], '1');
});

test('requests only as many jobs as there are free slots', async () => {
  const slow = await startFakeTarget((_req, res) => setTimeout(() => res.end('slow'), 600));
  try {
    const { runner } = makeRunner({ concurrency: 2 });
    worker.jobs.push(job('a', slow.url), job('b', slow.url), job('c', slow.url));
    runner.start();
    await waitFor(() => resultsFor('c').length === 1);
    await runner.stop();
    const leases = worker.requests.filter((r) => r.path === '/api/runner/lease').map((r) => r.body);
    assert.equal(leases[0].max, 2);
    assert.ok(leases.every((l) => l.max >= 1 && l.max <= 2 && l.waitMs === 200 && l.executorId === 'home'));
    assert.ok(leases.some((l) => l.max === 1), 'a lease with one free slot is requested while two jobs run');
  } finally {
    await slow.close();
  }
});

test('sends heartbeats with the in-flight job ids and fetch modes', async () => {
  const slow = await startFakeTarget((_req, res) => setTimeout(() => res.end('slow'), 800));
  try {
    const { runner } = makeRunner();
    worker.jobs.push(job('hb', slow.url));
    runner.start();
    await waitFor(() => worker.requests.some((r) => r.path === '/api/runner/heartbeat' && r.body.inflight.includes('hb')));
    await waitFor(() => resultsFor('hb').length === 1);
    await runner.stop();
    const hb = worker.requests.find((r) => r.path === '/api/runner/heartbeat')?.body;
    assert.equal(hb.runnerId, runner.runnerId);
    assert.deepEqual(hb.fetchModes, ['http']);
    assert.equal(hb.concurrency, 2);
    assert.equal(hb.version, 'test');
  } finally {
    await slow.close();
  }
});

test('reports fetch failures as error results', async () => {
  const config = loadConfig({ UTSUROI_BASE_URL: worker.url, CF_ACCESS_CLIENT_ID: 'a', CF_ACCESS_CLIENT_SECRET: 'b', BLOCKED_CIDRS: '93.184.216.0/24' });
  const { runner } = makeRunner({ createFetchService: (ms) => createRunnerFetchService(config, ms) });
  worker.jobs.push(
    job('lan', 'http://192.168.0.1/'),
    job('loop', target.url),
  );
  runner.start();
  await waitFor(() => resultsFor('lan').length === 1 && resultsFor('loop').length === 1);
  worker.jobs.push(job('home-ip', 'http://93.184.216.34/'));
  await waitFor(() => resultsFor('home-ip').length === 1);
  await runner.stop();
  for (const id of ['lan', 'loop', 'home-ip']) {
    const result = resultsFor(id)[0]?.body.result;
    assert.deepEqual([result.kind, result.failureClass], ['error', 'ssrf_blocked'], id);
  }
  assert.equal(target.hits, 0);
});

test('does not retry results rejected with 409', async () => {
  const { runner, logs } = makeRunner();
  worker.resultResponder = () => ({ status: 409, body: { error: { code: 'lease_expired', message: 'x' } } });
  worker.jobs.push(job('late', target.url));
  runner.start();
  await waitFor(() => resultsFor('late').length === 1);
  await waitFor(() => logs.lines.some((l) => l.includes('result rejected')));
  await runner.stop();
  assert.equal(resultsFor('late').length, 1);
});

test('retries results on 5xx', async () => {
  const { runner } = makeRunner();
  worker.resultResponder = (_id, attempt) => (attempt < 3 ? { status: 502 } : { status: 200, body: { accepted: true } });
  worker.jobs.push(job('flaky', target.url));
  runner.start();
  await waitFor(() => resultsFor('flaky').length === 3);
  await runner.stop();
  assert.equal(resultsFor('flaky').length, 3);
  assert.ok(resultsFor('flaky').every((r) => r.body.leaseToken === 'token-flaky'));
});

test('backs off on 401 and logs a configuration error without the secret', async () => {
  const { runner, logs } = makeRunner();
  worker.forceStatus = 401;
  runner.start();
  await waitFor(() => logs.lines.filter((l) => l.includes('authentication rejected')).length >= 3);
  const leaseCalls = worker.requests.filter((r) => r.path === '/api/runner/lease').length;
  assert.ok(leaseCalls < 50, `lease attempts should back off, saw ${leaseCalls}`);
  assert.equal(runner.isHealthy(), false);
  worker.forceStatus = null;
  await waitFor(() => runner.isHealthy());
  await runner.stop();
  assert.ok(logs.lines.every((l) => !l.includes(TOKEN_SECRET)));
});

test('stops leasing while the server reports maintenance', async () => {
  const { runner } = makeRunner();
  worker.maintenance = true;
  runner.start();
  try {
    await waitFor(() => worker.requests.some((r) => r.path === '/api/runner/heartbeat'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(worker.requests.filter((r) => r.path === '/api/runner/lease').length, 0);
    worker.maintenance = false;
    await waitFor(() => worker.requests.some((r) => r.path === '/api/runner/lease'));
  } finally {
    await runner.stop();
  }
});

test('on shutdown finishes in-flight jobs and delivers their results', async () => {
  let started = false;
  const slow = await startFakeTarget((_req, res) => {
    started = true;
    setTimeout(() => res.end('late'), 500);
  });
  try {
    const { runner, logs } = makeRunner();
    worker.jobs.push(job('drain', slow.url));
    runner.start();
    await waitFor(() => started);
    await runner.stop();
    assert.equal(resultsFor('drain').length, 1);
    assert.equal(Buffer.from(resultsFor('drain')[0]?.body.result.body, 'base64').toString(), 'late');
    const leasesAfter = worker.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(worker.requests.length, leasesAfter, 'no requests after stop');
    assert.ok(logs.lines.some((l) => l.includes('runner stopped')));
  } finally {
    await slow.close();
  }
});

test('skips jobs of an unsupported fetch mode and leases that are about to expire', async () => {
  const { runner } = makeRunner();
  worker.jobs.push(
    job('browser', target.url, { fetchMode: 'browser' }),
    job('stale', target.url, { leaseExpiresAt: new Date(Date.now() + 500).toISOString() }),
  );
  runner.start();
  await waitFor(() => worker.jobs.length === 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await runner.stop();
  assert.equal(target.hits, 0);
  assert.equal(worker.requests.filter((r) => r.path.endsWith('/result')).length, 0);
});

test('logs contain neither bodies nor lease tokens nor credentials', async () => {
  const { runner, logs } = makeRunner();
  worker.jobs.push(job('quiet', target.url));
  runner.start();
  await waitFor(() => resultsFor('quiet').length === 1);
  await runner.stop();
  const all = logs.lines.join('\n');
  assert.ok(all.includes('quiet'));
  for (const secret of ['token-quiet', TOKEN_SECRET, 'hello', 'aGVsbG8=']) assert.ok(!all.includes(secret), secret);
});

test('healthz reflects recent contact with the Worker', async () => {
  let now = 1_000_000;
  const { runner } = makeRunner({ now: () => now });
  const server = createHealthServer(() => runner.isHealthy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const status = async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).status;
  try {
    assert.equal(await status(), 503);
    runner.start();
    await waitFor(() => runner.isHealthy());
    assert.equal(await status(), 200);
    now += 61_000;
    assert.equal(await status(), 503);
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
  } finally {
    await runner.stop();
    server.close();
  }
});

test('protocol request fixtures match what the runner sends', async () => {
  const { runner } = makeRunner({ runnerId: fixture('heartbeat-request').runnerId, version: fixture('heartbeat-request').version });
  worker.jobs.length = 0;
  runner.start();
  await waitFor(() => worker.requests.some((r) => r.path === '/api/runner/lease') && worker.requests.some((r) => r.path === '/api/runner/heartbeat'));
  await runner.stop();
  const lease = worker.requests.find((r) => r.path === '/api/runner/lease')?.body;
  const hb = worker.requests.find((r) => r.path === '/api/runner/heartbeat')?.body;
  assert.deepEqual(Object.keys(lease).sort(), Object.keys(fixture('lease-request')).sort());
  assert.deepEqual({ ...hb, inflight: [] }, { ...fixture('heartbeat-request'), inflight: [] });
});
