import { PROTOCOL_HEADER, PROTOCOL_VERSION, parseHeartbeatResponse, parseLeaseResponse, parseResultResponse } from './protocol.ts';
import type {
  HeartbeatRequest,
  HeartbeatResponse,
  LeaseRequest,
  LeaseResponse,
  ResultRequest,
  ResultResponse,
} from './protocol.ts';

/** 401/403、または Access のログイン画面へのリダイレクト。設定誤りとして扱う */
export class AuthError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`unauthorized (${status})`);
    this.status = status;
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`unexpected status ${status}`);
    this.status = status;
  }
}

export class NetworkError extends Error {}

export interface ClientOptions {
  baseUrl: string;
  accessClientId: string;
  accessClientSecret: string;
  /** 結果送信を再試行するまでの待ち時間。要素数が再試行回数 */
  resultRetryDelaysMs?: readonly number[];
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RESULT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type ResultOutcome = ResultResponse | { rejected: 'lease_mismatch' | 'lease_expired' | 'not_found' | 'too_large' };

export class RunnerClient {
  private readonly options: ClientOptions;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ClientOptions) {
    this.options = options;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async post(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; json: unknown }> {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'cf-access-client-id': this.options.accessClientId,
          'cf-access-client-secret': this.options.accessClientSecret,
          [PROTOCOL_HEADER]: PROTOCOL_VERSION,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new NetworkError(err instanceof Error ? err.name : 'request failed');
    }
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new AuthError(response.status);
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // 本文が JSON でない場合はステータスだけで判断する
    }
    return { status: response.status, json };
  }

  async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    const { status, json } = await this.post('/api/runner/heartbeat', request, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    if (status !== 200) throw new HttpError(status);
    return parseHeartbeatResponse(json);
  }

  /** long-poll。waitMs に加えて通信の余裕を見た時間まで待つ。signal で中断できる */
  async lease(request: LeaseRequest, signal?: AbortSignal): Promise<LeaseResponse> {
    const { status, json } = await this.post('/api/runner/lease', request, request.waitMs + (this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS), signal);
    if (status !== 200) throw new HttpError(status);
    return parseLeaseResponse(json);
  }

  /** 5xx とネットワークエラーのときだけ再送する。409/404/413 は再送しない */
  async sendResult(jobId: string, request: ResultRequest): Promise<ResultOutcome> {
    const delays = this.options.resultRetryDelaysMs ?? DEFAULT_RESULT_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        const { status, json } = await this.post(
          `/api/runner/jobs/${encodeURIComponent(jobId)}/result`,
          request,
          this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        );
        if (status === 200) return parseResultResponse(json);
        if (status === 404) return { rejected: 'not_found' };
        if (status === 413) return { rejected: 'too_large' };
        if (status === 409) {
          const code = typeof json === 'object' && json !== null ? (json as Record<string, unknown>).error : undefined;
          return { rejected: code === 'lease_expired' ? 'lease_expired' : 'lease_mismatch' };
        }
        if (status < 500) throw new HttpError(status);
      } catch (err) {
        if (!(err instanceof NetworkError)) throw err;
      }
      const delay = delays[attempt];
      if (delay === undefined) throw new NetworkError('result delivery failed');
      await this.sleep(delay);
    }
  }
}
