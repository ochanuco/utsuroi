/**
 * /api/runner/* — Home Runner が Worker と話す pull プロトコル (ADR-0023 §4)。
 * RUNNER_EXECUTORS に載ったサービストークンだけが使え、CrawlerObject は対応表から引いた executor id で選ぶ。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ZodType, z } from 'zod';
import { crawlerStub } from '../../do/crawlerObject';
import {
  RUNNER_PROTOCOL_HEADER,
  RUNNER_PROTOCOL_VERSION,
  heartbeatRequestSchema,
  leaseRequestSchema,
  maxResultRequestBytes,
  resultRequestSchema,
  type HeartbeatResponse,
  type LeaseResponse,
  type ResultResponse,
} from '../../runner/protocol';
import { DEFAULT_FETCH_LIMITS } from '../../shared/contracts';
import type { AppEnv } from '../auth';
import { ApiError, badRequest, forbidden, notFound, payloadTooLarge } from '../errors';
import { parseWith } from '../http';
import { runnerExecutorFor } from '../runnerAuth';

const SMALL_BODY_LIMIT = 16 * 1024;

async function readLimitedJson(c: Context<AppEnv>, limit: number): Promise<unknown> {
  const declared = c.req.header('content-length');
  if (declared !== undefined && Number(declared) > limit) throw payloadTooLarge('payload_too_large', 'request body is too large');
  if (!(c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) {
    throw badRequest('invalid_content_type', 'request body must be application/json');
  }
  const body = c.req.raw.body;
  if (!body) throw badRequest('invalid_json', 'request body must be valid JSON');

  // Content-Length を偽られても上限を超えて読み込まない
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw payloadTooLarge('payload_too_large', 'request body is too large');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged));
  } catch {
    throw badRequest('invalid_json', 'request body must be valid JSON');
  }
}

async function parseBody<T extends ZodType>(c: Context<AppEnv>, schema: T, limit: number): Promise<z.infer<T>> {
  return parseWith(schema, await readLimitedJson(c, limit));
}

export function runnerRoutes() {
  const router = new Hono<AppEnv>();

  router.use('*', async (c, next) => {
    const executorId = runnerExecutorFor(c.get('caller'), c.env.RUNNER_EXECUTORS);
    if (!executorId) throw forbidden('forbidden', 'caller is not a registered runner');
    if (c.req.header(RUNNER_PROTOCOL_HEADER) !== RUNNER_PROTOCOL_VERSION) {
      throw badRequest('unsupported_protocol', `${RUNNER_PROTOCOL_HEADER}: ${RUNNER_PROTOCOL_VERSION} is required`);
    }
    c.set('runnerExecutorId', executorId);
    await next();
  });

  function callerExecutor(c: Context<AppEnv>): string {
    const executorId = c.get('runnerExecutorId');
    if (!executorId) throw forbidden('forbidden', 'caller is not a registered runner');
    return executorId;
  }

  function assertExecutor(c: Context<AppEnv>, requested: string): string {
    const executorId = callerExecutor(c);
    if (requested !== executorId) throw forbidden('executor_mismatch', 'executorId does not match the caller');
    return executorId;
  }

  router.post('/heartbeat', async (c) => {
    const body = await parseBody(c, heartbeatRequestSchema, SMALL_BODY_LIMIT);
    const executorId = assertExecutor(c, body.executorId);
    const { maintenance } = await crawlerStub(c.env, executorId).heartbeat({
      executorId,
      runnerId: body.runnerId,
      version: body.version,
      fetchModes: body.fetchModes,
      concurrency: body.concurrency,
      inflight: body.inflight.length,
    });
    const res: HeartbeatResponse = { serverTime: new Date().toISOString(), maintenance };
    return c.json(res);
  });

  router.post('/lease', async (c) => {
    const body = await parseBody(c, leaseRequestSchema, SMALL_BODY_LIMIT);
    const executorId = assertExecutor(c, body.executorId);
    const jobs = await crawlerStub(c.env, executorId).lease(
      { executorId, runnerId: body.runnerId, fetchModes: body.fetchModes },
      body.max,
      body.waitMs,
    );
    const res: LeaseResponse = { jobs };
    return c.json(res);
  });

  router.post('/jobs/:jobId/result', async (c) => {
    const executorId = callerExecutor(c);
    const body = await parseBody(c, resultRequestSchema, maxResultRequestBytes(DEFAULT_FETCH_LIMITS.maxBytes));
    const outcome = await crawlerStub(c.env, executorId).complete(c.req.param('jobId'), body.leaseToken, body.result);
    switch (outcome) {
      case 'accepted':
      case 'duplicate': {
        const res: ResultResponse = outcome === 'duplicate' ? { accepted: true, duplicate: true } : { accepted: true };
        return c.json(res);
      }
      case 'lease_mismatch':
        throw new ApiError(409, 'lease_mismatch', 'lease token does not match');
      case 'lease_expired':
        throw new ApiError(409, 'lease_expired', 'lease has expired');
      case 'too_large':
        throw payloadTooLarge('payload_too_large', 'result body exceeds the job maxBytes');
      case 'not_found':
        throw notFound('not_found', 'job not found');
    }
  });

  return router;
}
