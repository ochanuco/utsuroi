import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFetchService } from '../../shared/src/fetcher.ts';
import type { FetchService } from '../../shared/src/fetcher.ts';
import type { Logger } from '../src/log.ts';

export const TOKEN_SECRET = 'secret-service-token-value';

/** keep-alive 接続が残っていても待たずに閉じる */
export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export interface Recorded {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface FakeWorker {
  url: string;
  requests: Recorded[];
  jobs: any[];
  maintenance: boolean;
  /** /result への応答を差し替える。呼び出し回数 (1 始まり) を受け取る */
  resultResponder: (jobId: string, attempt: number) => { status: number; body?: unknown };
  forceStatus: number | null;
  /**
   * 設定すると、別の runnerId からの lease には job を渡さず、記録もしない。
   * 前のテストで stop() が中断した lease が遅れて届き、次のテストの job を持っていくのを防ぐ
   */
  activeRunnerId: string | null;
  close(): Promise<void>;
}

export async function startFakeWorker(): Promise<FakeWorker> {
  const resultAttempts = new Map<string, number>();
  const worker: FakeWorker = {
    url: '',
    requests: [],
    jobs: [],
    maintenance: false,
    resultResponder: () => ({ status: 200, body: { accepted: true } }),
    forceStatus: null,
    activeRunnerId: null,
    close: () => closeServer(server),
  };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const path = req.url ?? '';
    const send = (status: number, payload: unknown) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json' }).end(text);
    };
    if (path === '/api/runner/lease' && worker.activeRunnerId !== null && body?.runnerId !== worker.activeRunnerId) {
      send(200, { jobs: [] });
      return;
    }
    worker.requests.push({ path, headers: req.headers, body });
    if (worker.forceStatus !== null) {
      res.writeHead(worker.forceStatus).end();
      return;
    }
    if (path === '/api/runner/heartbeat') {
      send(200, { serverTime: new Date().toISOString(), maintenance: worker.maintenance });
    } else if (path === '/api/runner/lease') {
      if (worker.maintenance) {
        send(200, { jobs: [] });
      } else if (worker.jobs.length > 0) {
        send(200, { jobs: worker.jobs.splice(0, body.max) });
      } else {
        const timer = setTimeout(() => send(200, { jobs: [] }), 100);
        res.on('close', () => clearTimeout(timer));
      }
    } else if (path.startsWith('/api/runner/jobs/') && path.endsWith('/result')) {
      const jobId = decodeURIComponent(path.split('/')[4] ?? '');
      const attempt = (resultAttempts.get(jobId) ?? 0) + 1;
      resultAttempts.set(jobId, attempt);
      const r = worker.resultResponder(jobId, attempt);
      send(r.status, r.body ?? {});
    } else {
      send(404, {});
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  worker.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return worker;
}

export interface FakeTarget {
  url: string;
  hits: number;
  close(): Promise<void>;
}

export async function startFakeTarget(handler?: http.RequestListener): Promise<FakeTarget> {
  const target: FakeTarget = { url: '', hits: 0, close: () => closeServer(server) };
  const server = http.createServer((req, res) => {
    target.hits++;
    if (handler) return handler(req, res);
    res.writeHead(200, { 'content-type': 'text/plain', etag: '"v1"' }).end('hello');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  target.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return target;
}

/** 127.0.0.1 の偽ターゲットへ接続できる取得処理 (SSRF 検査は無効化) */
export function permissiveFetchService(timeoutMs: number): FetchService {
  return createFetchService({
    maxBytesCap: 1024 * 1024,
    timeoutMs,
    maxRedirects: 5,
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    isBlockedAddress: () => false,
    allowedPorts: new Set(Array.from({ length: 65535 }, (_, i) => i + 1)),
  });
}

export function captureLogs(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { lines, logger: (level, msg, fields) => void lines.push(JSON.stringify({ level, msg, ...fields })) };
}

export async function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function job(id: string, url: string, overrides: Record<string, unknown> = {}): any {
  return {
    jobId: id,
    leaseToken: `token-${id}`,
    leaseExpiresAt: new Date(Date.now() + 40_000).toISOString(),
    fetchMode: 'http',
    request: { url, maxBytes: 1024 * 1024, headers: { 'if-none-match': '"v1"' } },
    ...overrides,
  };
}
