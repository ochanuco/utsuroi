import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { crawlerStub } from '../../src/do/crawlerObject';
import {
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  leaseRequestSchema,
  leaseResponseSchema,
  resultRequestSchema,
  resultResponseSchema,
} from '../../src/runner/protocol';
import heartbeatRequestFx from '../fixtures/runner-protocol/heartbeat-request.json';
import heartbeatResponseFx from '../fixtures/runner-protocol/heartbeat-response.json';
import leaseRequestFx from '../fixtures/runner-protocol/lease-request.json';
import leaseResponseFx from '../fixtures/runner-protocol/lease-response.json';
import resultRequestErrorFx from '../fixtures/runner-protocol/result-request-error.json';
import resultRequestResponseFx from '../fixtures/runner-protocol/result-request-response.json';
import resultResponseAcceptedFx from '../fixtures/runner-protocol/result-response-accepted.json';
import resultResponseDuplicateFx from '../fixtures/runner-protocol/result-response-duplicate.json';
import { baseClaims, signJwt } from './accessJwt';
import { authHeaders, buildTestApp, testEnv, testKeyPair } from './helpers';

const RUNNER_CLIENT_ID = 'runner-client.access';
const OTHER_CLIENT_ID = 'other-client.access';
const PROTOCOL = { 'utsuroi-runner-protocol': '1' };

let seq = 0;
function newCtx() {
  const executorId = `home-${Date.now()}-${++seq}`;
  const env = testEnv({
    ACCESS_CALLERS: JSON.stringify({ [RUNNER_CLIENT_ID]: 'runner-home', [OTHER_CLIENT_ID]: 'other' }),
    RUNNER_EXECUTORS: JSON.stringify({ 'runner-home': executorId }),
  });
  const { app } = buildTestApp();
  return { executorId, env, app };
}

async function runnerHeaders(clientId = RUNNER_CLIENT_ID, extra: Record<string, string> = PROTOCOL) {
  const jwt = await signJwt(testKeyPair, baseClaims({ common_name: clientId, exp: Math.floor(Date.now() / 1000) + 3600 }));
  return { 'cf-access-jwt-assertion': jwt, 'content-type': 'application/json', ...extra };
}

type Ctx = ReturnType<typeof newCtx>;

async function post(ctx: Ctx, path: string, body: unknown, headers?: Record<string, string>) {
  return ctx.app.request(
    `/api/runner${path}`,
    { method: 'POST', headers: headers ?? (await runnerHeaders()), body: typeof body === 'string' ? body : JSON.stringify(body) },
    ctx.env,
  );
}

const hb = (ctx: Ctx, over: Record<string, unknown> = {}) => ({ ...heartbeatRequestFx, executorId: ctx.executorId, inflight: [], ...over });
const ls = (ctx: Ctx, over: Record<string, unknown> = {}) => ({ ...leaseRequestFx, executorId: ctx.executorId, waitMs: 2000, ...over });

function submit(ctx: Ctx, jobId: string, over: { leaseWaitMs?: number; resultWaitMs?: number } = {}) {
  return crawlerStub(ctx.env, ctx.executorId).submitAndWait(
    { executorId: ctx.executorId, jobId, fetchMode: 'http', request: { url: 'https://example.com/feed.xml', maxBytes: 5 * 1024 * 1024, headers: {} } },
    { leaseWaitMs: 5000, resultWaitMs: 5000, ...over },
  );
}

describe('protocol fixtures', () => {
  const cases: Array<[string, ZodType, unknown]> = [
    ['heartbeat-request', heartbeatRequestSchema, heartbeatRequestFx],
    ['heartbeat-response', heartbeatResponseSchema, heartbeatResponseFx],
    ['lease-request', leaseRequestSchema, leaseRequestFx],
    ['lease-response', leaseResponseSchema, leaseResponseFx],
    ['result-request-response', resultRequestSchema, resultRequestResponseFx],
    ['result-request-error', resultRequestSchema, resultRequestErrorFx],
    ['result-response-accepted', resultResponseSchema, resultResponseAcceptedFx],
    ['result-response-duplicate', resultResponseSchema, resultResponseDuplicateFx],
  ];
  it.each(cases)('%s passes its schema', (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(true);
  });

  it('rejects unknown failure classes and malformed bodies', () => {
    expect(
      resultRequestSchema.safeParse({ leaseToken: 't', result: { kind: 'error', failureClass: 'http_5xx', message: 'x' } }).success,
    ).toBe(false);
    expect(
      resultRequestSchema.safeParse({ ...resultRequestResponseFx, result: { ...resultRequestResponseFx.result, body: 'not base64!' } }).success,
    ).toBe(false);
  });
});

describe('/api/runner authorization', () => {
  it('rejects human callers with 403', async () => {
    const ctx = newCtx();
    const res = await post(ctx, '/heartbeat', hb(ctx), { ...authHeaders(), 'content-type': 'application/json', ...PROTOCOL });
    expect(res.status).toBe(403);
  });

  it('rejects service tokens that are not in RUNNER_EXECUTORS with 403', async () => {
    const ctx = newCtx();
    const res = await post(ctx, '/heartbeat', hb(ctx), await runnerHeaders(OTHER_CLIENT_ID));
    expect(res.status).toBe(403);
  });

  it.each([['{}'], ['not json'], ['[]']])('rejects every caller while RUNNER_EXECUTORS is %s', async (raw) => {
    const ctx = newCtx();
    ctx.env.RUNNER_EXECUTORS = raw;
    expect((await post(ctx, '/heartbeat', hb(ctx))).status).toBe(403);
  });

  it('confines a runner token to /api/runner/*', async () => {
    const ctx = newCtx();
    for (const [method, path] of [
      ['GET', '/api/sites'],
      ['POST', '/api/sites'],
      ['GET', '/api/jobs'],
      ['GET', '/api/runner'],
      ['GET', '/api/executors'],
    ] as const) {
      const res = await ctx.app.request(path, { method, headers: await runnerHeaders() }, ctx.env);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('keeps human callers working on the other routes', async () => {
    const ctx = newCtx();
    expect((await ctx.app.request('/api/sites', { headers: authHeaders() }, ctx.env)).status).toBe(200);
  });

  it('rejects an executorId that differs from the one mapped to the caller', async () => {
    const ctx = newCtx();
    expect((await post(ctx, '/heartbeat', hb(ctx, { executorId: 'someone-else' }))).status).toBe(403);
    expect((await post(ctx, '/lease', ls(ctx, { executorId: 'someone-else' }))).status).toBe(403);
  });

  it('requires a known protocol version', async () => {
    const ctx = newCtx();
    const variants: Array<Record<string, string>> = [{}, { 'utsuroi-runner-protocol': '2' }, { 'utsuroi-runner-protocol': '' }];
    for (const extra of variants) {
      const res = await post(ctx, '/heartbeat', hb(ctx), await runnerHeaders(RUNNER_CLIENT_ID, extra));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unsupported_protocol');
    }
  });

  it('rejects invalid JSON and invalid bodies with 400', async () => {
    const ctx = newCtx();
    expect((await post(ctx, '/heartbeat', '{nope')).status).toBe(400);
    expect((await post(ctx, '/lease', ls(ctx, { max: 0 }))).status).toBe(400);
    expect((await post(ctx, '/lease', ls(ctx, { waitMs: 20001 }))).status).toBe(400);
  });
});

describe('/api/runner protocol round trip', () => {
  it('heartbeat reports maintenance=false and registers the runner', async () => {
    const ctx = newCtx();
    const res = await post(ctx, '/heartbeat', hb(ctx));
    expect(res.status).toBe(200);
    expect(heartbeatResponseSchema.parse(await res.json())).toMatchObject({ maintenance: false });
    expect((await crawlerStub(ctx.env, ctx.executorId).status()).online).toBe(true);
  });

  it('heartbeat reports maintenance=true when the executor is in maintenance', async () => {
    const ctx = newCtx();
    await ctx.env.DB.prepare(
      `INSERT INTO executors (id, kind, name, capabilities, status, created_at, updated_at) VALUES (?, 'home_runner', 'm', NULL, 'maintenance', 'x', 'x')`,
    )
      .bind(ctx.executorId)
      .run();
    const res = await post(ctx, '/heartbeat', hb(ctx));
    expect(((await res.json()) as { maintenance: boolean }).maintenance).toBe(true);
  });

  it('lease -> result delivers the response to the waiting check, and a replay is a duplicate', async () => {
    const ctx = newCtx();
    await post(ctx, '/heartbeat', hb(ctx));
    const jobId = crypto.randomUUID();
    const waiting = submit(ctx, jobId);

    const leaseRes = await post(ctx, '/lease', ls(ctx));
    expect(leaseRes.status).toBe(200);
    const { jobs } = leaseResponseSchema.parse(await leaseRes.json());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ jobId, fetchMode: 'http', request: { url: 'https://example.com/feed.xml' } });

    const payload = { leaseToken: jobs[0]!.leaseToken, result: resultRequestResponseFx.result };
    const first = await post(ctx, `/jobs/${jobId}/result`, payload);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ accepted: true });
    expect(await waiting).toMatchObject({ kind: 'result', result: { kind: 'response', status: 200 } });

    const replay = await post(ctx, `/jobs/${jobId}/result`, payload);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ accepted: true, duplicate: true });
  });

  it('answers 409 lease_mismatch / 404 / 409 lease_expired', async () => {
    const ctx = newCtx();
    await post(ctx, '/heartbeat', hb(ctx));
    const jobId = crypto.randomUUID();
    const waiting = submit(ctx, jobId, { resultWaitMs: 1500 });
    const { jobs } = leaseResponseSchema.parse(await (await post(ctx, '/lease', ls(ctx))).json());

    const bad = await post(ctx, `/jobs/${jobId}/result`, { leaseToken: 'wrong', result: resultRequestResponseFx.result });
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('lease_mismatch');

    const unknown = await post(ctx, `/jobs/${crypto.randomUUID()}/result`, { leaseToken: 'x', result: resultRequestResponseFx.result });
    expect(unknown.status).toBe(404);

    await waiting;
    const late = await post(ctx, `/jobs/${jobId}/result`, { leaseToken: jobs[0]!.leaseToken, result: resultRequestResponseFx.result });
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: { code: string } }).error.code).toBe('lease_expired');
  });

  it("does not let a runner see or complete another executor's job", async () => {
    const a = newCtx();
    const b = newCtx();
    await post(a, '/heartbeat', hb(a));
    const jobId = crypto.randomUUID();
    const waiting = submit(a, jobId, { leaseWaitMs: 500 });
    const { jobs } = leaseResponseSchema.parse(await (await post(a, '/lease', ls(a))).json());

    await post(b, '/heartbeat', hb(b));
    expect(leaseResponseSchema.parse(await (await post(b, '/lease', ls(b, { waitMs: 0 }))).json()).jobs).toEqual([]);
    const stolen = await post(b, `/jobs/${jobId}/result`, { leaseToken: jobs[0]!.leaseToken, result: resultRequestResponseFx.result });
    expect(stolen.status).toBe(404);

    await post(a, `/jobs/${jobId}/result`, { leaseToken: jobs[0]!.leaseToken, result: resultRequestResponseFx.result });
    await waiting;
  });

  it('answers an empty lease after the wait when no job is queued', async () => {
    const ctx = newCtx();
    await post(ctx, '/heartbeat', hb(ctx));
    const res = await post(ctx, '/lease', ls(ctx, { waitMs: 200 }));
    expect(await res.json()).toEqual({ jobs: [] });
  });

  it('rejects an oversized result with 413 and never reaches the waiter', async () => {
    const ctx = newCtx();
    await post(ctx, '/heartbeat', hb(ctx));
    const jobId = crypto.randomUUID();
    const waiting = submit(ctx, jobId, { resultWaitMs: 1500 });
    const { jobs } = leaseResponseSchema.parse(await (await post(ctx, '/lease', ls(ctx))).json());

    const huge = 'A'.repeat(8 * 1024 * 1024);
    const res = await post(ctx, `/jobs/${jobId}/result`, {
      leaseToken: jobs[0]!.leaseToken,
      result: { ...resultRequestResponseFx.result, body: huge },
    });
    expect(res.status).toBe(413);
    expect(await waiting).toMatchObject({ kind: 'unavailable', reason: 'result_timeout' });
  });

  it('rejects a result whose body exceeds the job maxBytes with 413', async () => {
    const ctx = newCtx();
    await post(ctx, '/heartbeat', hb(ctx));
    const jobId = crypto.randomUUID();
    const waiting = crawlerStub(ctx.env, ctx.executorId).submitAndWait(
      { executorId: ctx.executorId, jobId, fetchMode: 'http', request: { url: 'https://example.com/', maxBytes: 3, headers: {} } },
      { leaseWaitMs: 5000, resultWaitMs: 5000 },
    );
    const { jobs } = leaseResponseSchema.parse(await (await post(ctx, '/lease', ls(ctx))).json());
    const res = await post(ctx, `/jobs/${jobId}/result`, {
      leaseToken: jobs[0]!.leaseToken,
      result: { ...resultRequestResponseFx.result, body: 'AAAAAAAA' },
    });
    expect(res.status).toBe(413);
    await post(ctx, `/jobs/${jobId}/result`, { leaseToken: jobs[0]!.leaseToken, result: { ...resultRequestResponseFx.result, body: 'AAAA' } });
    await waiting;
  });
});
