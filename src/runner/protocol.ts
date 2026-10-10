/**
 * Home Runner pull プロトコル v1 (ADR-0023 §4)。
 * リクエスト・応答のスキーマと型。Runner 側テストも test/fixtures/runner-protocol/*.json を通して整合を保つ。
 */
import { z } from 'zod';

export const RUNNER_PROTOCOL_VERSION = '1';
export const RUNNER_PROTOCOL_HEADER = 'utsuroi-runner-protocol';

/** long-poll の最大保持時間 (ms) */
export const MAX_LEASE_WAIT_MS = 20_000;
/** 1 回の lease で受け取れる job 数の上限 */
export const MAX_LEASE_JOBS = 16;
/** result 本文の上限に足す、JSON 包みとヘッダ分の余白 */
export const RESULT_ENVELOPE_ALLOWANCE = 64 * 1024;

/** job に載せる request header の許可リスト (GCP Executor と同じ) */
export const RUNNER_REQUEST_HEADERS: readonly string[] = [
  'user-agent',
  'accept',
  'accept-language',
  'referer',
  'if-none-match',
  'if-modified-since',
];

/** Runner が kind='error' で返してよい分類 (GCP Executor と同じ) */
export const RUNNER_ERROR_CLASSES = ['ssrf_blocked', 'timeout', 'network_error', 'too_large'] as const;

/** base64 本文の最大長 (文字数)。maxBytes の base64 換算 */
export function maxBase64Length(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4;
}

/** result リクエスト全体の最大バイト数 (maxBytes の base64 換算 + 64KiB) */
export function maxResultRequestBytes(maxBytes: number): number {
  return maxBase64Length(maxBytes) + RESULT_ENVELOPE_ALLOWANCE;
}

const id = z.string().min(1).max(128);
const fetchModes = z.array(z.string().min(1).max(32)).max(8);

export const heartbeatRequestSchema = z.object({
  executorId: id,
  runnerId: id,
  version: z.string().max(64),
  fetchModes,
  concurrency: z.number().int().min(1).max(64),
  inflight: z.array(id).max(64),
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

export const heartbeatResponseSchema = z.object({
  serverTime: z.string(),
  maintenance: z.boolean(),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

export const leaseRequestSchema = z.object({
  executorId: id,
  runnerId: id,
  max: z.number().int().min(1).max(MAX_LEASE_JOBS),
  waitMs: z.number().int().min(0).max(MAX_LEASE_WAIT_MS),
  fetchModes,
});
export type LeaseRequest = z.infer<typeof leaseRequestSchema>;

export const leasedJobSchema = z.object({
  jobId: id,
  leaseToken: z.string().min(1).max(128),
  leaseExpiresAt: z.string(),
  fetchMode: z.string().min(1).max(32),
  request: z.object({
    url: z.string().min(1).max(8192),
    maxBytes: z.number().int().positive(),
    headers: z.record(z.string(), z.string()),
  }),
});
export type LeasedJob = z.infer<typeof leasedJobSchema>;

export const leaseResponseSchema = z.object({ jobs: z.array(leasedJobSchema) });
export type LeaseResponse = z.infer<typeof leaseResponseSchema>;

const responseHeaders = z
  .record(z.string().max(256), z.string().max(8192))
  .refine((h) => Object.keys(h).length <= 200, 'too many headers');

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

export const runnerResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('response'),
    status: z.number().int().min(100).max(599),
    url: z.string().min(1).max(8192),
    contentType: z.string().max(1024).nullable(),
    headers: responseHeaders,
    body: base64,
    truncated: z.boolean(),
    durationMs: z.number().min(0),
  }),
  z.object({
    kind: z.literal('error'),
    failureClass: z.enum(RUNNER_ERROR_CLASSES),
    message: z.string().max(1024),
  }),
]);
export type RunnerResult = z.infer<typeof runnerResultSchema>;

export const resultRequestSchema = z.object({
  leaseToken: z.string().min(1).max(128),
  result: runnerResultSchema,
});
export type ResultRequest = z.infer<typeof resultRequestSchema>;

export const resultResponseSchema = z.object({
  accepted: z.literal(true),
  duplicate: z.literal(true).optional(),
});
export type ResultResponse = z.infer<typeof resultResponseSchema>;
