import { parseCidrList } from '../../shared/src/addressPolicy.ts';
import type { ExtraBlockList } from '../../shared/src/addressPolicy.ts';

export interface Config {
  baseUrl: string;
  accessClientId: string;
  accessClientSecret: string;
  executorId: string;
  concurrency: number;
  healthPort: number;
  blockedCidrs: ExtraBlockList;
  allowIpv6: boolean;
  fetchTimeoutMs: number;
  maxBytesCap: number;
  version: string;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function intInRange(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be true or false`);
}

function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('UTSUROI_BASE_URL must be a valid URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('UTSUROI_BASE_URL must use https');
  }
  if (url.username !== '' || url.password !== '') throw new Error('UTSUROI_BASE_URL must not contain credentials');
  return url.origin;
}

/** 環境変数から設定を作る。必須の欠落や不正値は例外 (起動時に終了させる) */
export function loadConfig(env: Env): Config {
  return {
    baseUrl: parseBaseUrl(required(env, 'UTSUROI_BASE_URL')),
    accessClientId: required(env, 'CF_ACCESS_CLIENT_ID'),
    accessClientSecret: required(env, 'CF_ACCESS_CLIENT_SECRET'),
    executorId: env.EXECUTOR_ID?.trim() || 'home',
    concurrency: intInRange(env, 'CONCURRENCY', 2, 1, 16),
    healthPort: intInRange(env, 'HEALTH_PORT', 8080, 1, 65535),
    blockedCidrs: parseCidrList(env.BLOCKED_CIDRS ?? ''),
    allowIpv6: bool(env, 'ALLOW_IPV6', false),
    fetchTimeoutMs: intInRange(env, 'FETCH_TIMEOUT_MS', 30_000, 1_000, 35_000),
    maxBytesCap: intInRange(env, 'MAX_BYTES_CAP', 5 * 1024 * 1024, 1, 64 * 1024 * 1024),
    version: env.GIT_SHA?.trim() || 'dev',
  };
}
