import http from 'node:http';
import { AuthError, JtiCache, parsePublicKey, verifyRequestToken } from './jwt.ts';
import { FetchFailure, createFetchService } from '../../shared/src/fetcher.ts';
import type { FetchService } from '../../shared/src/fetcher.ts';
import type { KeyObject } from 'node:crypto';

const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export interface ServerOptions {
  publicKey: KeyObject;
  fetchService: FetchService;
  maxBytesCap: number;
  maxInflight: number;
  now?: () => number;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_REQUEST_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

interface ParsedRequest {
  url: string;
  maxBytes: number;
  headers: Record<string, string>;
}

function parseRequest(raw: Buffer, maxBytesCap: number): ParsedRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { url, maxBytes, headers } = value as Record<string, unknown>;
  if (typeof url !== 'string' || url === '') return null;
  let limit = DEFAULT_MAX_BYTES;
  if (maxBytes !== undefined) {
    if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes <= 0) return null;
    limit = maxBytes;
  }
  const outHeaders: Record<string, string> = {};
  if (headers !== undefined) {
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return null;
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v !== 'string') return null;
      outHeaders[k] = v;
    }
  }
  return { url, maxBytes: Math.min(limit, maxBytesCap), headers: outHeaders };
}

export function createServer(opts: ServerOptions): http.Server {
  const jtiCache = new JtiCache();
  let inflight = 0;

  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/') {
        sendJson(res, 404, { error: 'not found' });
        req.resume();
        return;
      }
      const authorization = req.headers.authorization;
      if (!authorization) {
        sendJson(res, 401, { error: 'unauthorized' });
        req.resume();
        return;
      }
      const raw = await readBody(req);
      if (raw === null) {
        sendJson(res, 413, { error: 'request too large' });
        return;
      }
      try {
        verifyRequestToken(authorization, raw, { publicKey: opts.publicKey, jtiCache, now: opts.now });
      } catch (err) {
        if (err instanceof AuthError) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        throw err;
      }

      const parsed = parseRequest(raw, opts.maxBytesCap);
      if (!parsed) {
        sendJson(res, 400, { error: 'invalid request' });
        return;
      }
      if (inflight >= opts.maxInflight) {
        sendJson(res, 503, { error: 'busy' });
        return;
      }

      inflight++;
      const startedAt = Date.now();
      try {
        const result = await opts.fetchService(parsed);
        sendJson(res, 200, {
          kind: 'response',
          status: result.status,
          url: result.url,
          contentType: result.contentType,
          headers: result.headers,
          body: result.body.toString('base64'),
          truncated: result.truncated,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        if (err instanceof FetchFailure) {
          sendJson(res, 200, { kind: 'error', failureClass: err.failureClass, message: err.message });
        } else {
          throw err;
        }
      } finally {
        inflight--;
      }
    } catch (err) {
      console.error('unhandled error', err instanceof Error ? err.message : err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  });
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const pem = process.env.EXECUTOR_PUBLIC_KEY;
  if (!pem) throw new Error('EXECUTOR_PUBLIC_KEY is required');
  const maxBytesCap = envInt('EXECUTOR_MAX_BYTES_CAP', 5 * 1024 * 1024);
  const server = createServer({
    publicKey: parsePublicKey(pem),
    fetchService: createFetchService({
      maxBytesCap,
      timeoutMs: envInt('EXECUTOR_TIMEOUT_MS', 25_000),
      maxRedirects: 5,
    }),
    maxBytesCap,
    maxInflight: envInt('EXECUTOR_MAX_INFLIGHT', 8),
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(envInt('PORT', 8080));
}
