export const PROTOCOL_HEADER = 'Utsuroi-Runner-Protocol';
export const PROTOCOL_VERSION = '1';
export const FETCH_MODES = ['http'];
/** サーバー側の上限 (ADR-0023 §4) */
export const MAX_LEASE_WAIT_MS = 20_000;

export interface HeartbeatRequest {
  executorId: string;
  runnerId: string;
  version: string;
  fetchModes: string[];
  concurrency: number;
  inflight: string[];
}

export interface HeartbeatResponse {
  serverTime: string;
  maintenance: boolean;
}

export interface LeaseRequest {
  executorId: string;
  runnerId: string;
  max: number;
  waitMs: number;
  fetchModes: string[];
}

export interface LeasedJob {
  jobId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  fetchMode: string;
  request: { url: string; maxBytes: number; headers: Record<string, string> };
}

export interface LeaseResponse {
  jobs: LeasedJob[];
}

export type JobResult =
  | {
      kind: 'response';
      status: number;
      url: string;
      contentType: string | null;
      headers: Record<string, string>;
      body: string;
      truncated: boolean;
      durationMs: number;
    }
  | { kind: 'error'; failureClass: 'ssrf_blocked' | 'timeout' | 'network_error' | 'too_large'; message: string };

export interface ResultRequest {
  leaseToken: string;
  result: JobResult;
}

export interface ResultResponse {
  accepted: boolean;
  duplicate?: boolean;
}

export class ProtocolError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '') throw new ProtocolError(`${what} must be a non-empty string`);
  return v;
}

export function parseHeartbeatResponse(value: unknown): HeartbeatResponse {
  if (!isRecord(value) || typeof value.maintenance !== 'boolean') throw new ProtocolError('invalid heartbeat response');
  return { serverTime: typeof value.serverTime === 'string' ? value.serverTime : '', maintenance: value.maintenance };
}

export function parseLeaseResponse(value: unknown): LeaseResponse {
  if (!isRecord(value) || !Array.isArray(value.jobs)) throw new ProtocolError('invalid lease response');
  const jobs = value.jobs.map((raw): LeasedJob => {
    if (!isRecord(raw) || !isRecord(raw.request)) throw new ProtocolError('invalid job');
    const { url, maxBytes, headers } = raw.request;
    if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes <= 0) throw new ProtocolError('invalid maxBytes');
    const outHeaders: Record<string, string> = {};
    if (headers !== undefined) {
      if (!isRecord(headers)) throw new ProtocolError('invalid headers');
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v !== 'string') throw new ProtocolError('invalid header value');
        outHeaders[k] = v;
      }
    }
    return {
      jobId: str(raw.jobId, 'jobId'),
      leaseToken: str(raw.leaseToken, 'leaseToken'),
      leaseExpiresAt: str(raw.leaseExpiresAt, 'leaseExpiresAt'),
      fetchMode: str(raw.fetchMode, 'fetchMode'),
      request: { url: str(url, 'url'), maxBytes, headers: outHeaders },
    };
  });
  return { jobs };
}

export function parseResultResponse(value: unknown): ResultResponse {
  if (!isRecord(value) || typeof value.accepted !== 'boolean') throw new ProtocolError('invalid result response');
  return value.duplicate === true ? { accepted: value.accepted, duplicate: true } : { accepted: value.accepted };
}
