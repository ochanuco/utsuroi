/**
 * robots.txt の取得・キャッシュ・評価を統合する checkRobots。
 */
import type { RobotsDecision } from '../shared/contracts';
import { parseRobotsTxt } from './parser';
import { evaluateRobots } from './evaluator';
import { EMPTY_ROBOTS_RULES, type CachedRobots, type RobotsCache, type RobotsRules } from './types';

export const DEFAULT_ROBOTS_USER_AGENT = 'UtsuroiBot/1.0 (+https://utsuroi.example/bot)';
export const DEFAULT_UA_TOKEN = 'utsuroibot';
export const DEFAULT_ROBOTS_TTL_SECONDS = 3600;
export const MAX_ROBOTS_BYTES = 500 * 1024; // 500 KiB

export interface CheckRobotsOptions {
  /** robots.txt 取得に使う fetch 実装。既定 globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** 送信する User-Agent ヘッダ値 */
  userAgent?: string;
  /** グループ選択に使う UA トークン (部分一致対象) */
  uaToken?: string;
  /** robots.txt キャッシュ (未指定なら毎回取得) */
  cache?: RobotsCache;
  /** キャッシュ TTL 秒。既定 3600 */
  ttlSeconds?: number;
  /** テスト用の時刻注入 (epoch ms) */
  now?: () => number;
}

async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    const bytes = new TextEncoder().encode(text);
    if (bytes.length <= maxBytes) return text;
    return new TextDecoder().decode(bytes.subarray(0, maxBytes));
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (total >= maxBytes) break;
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;
    const remaining = maxBytes - total;
    if (value.length > remaining) {
      chunks.push(value.subarray(0, remaining));
      total += remaining;
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  try {
    await reader.cancel();
  } catch {
    // ストリームが既に終了している場合などは無視
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

async function fetchRobots(
  robotsUrl: string,
  fetchImpl: typeof fetch,
  userAgent: string,
  nowIso: string,
): Promise<CachedRobots> {
  let response: Response;
  try {
    response = await fetchImpl(robotsUrl, { headers: { 'user-agent': userAgent } });
  } catch {
    // ネットワークエラー → 取得不能 (RFC 9309: disallow 扱い)
    return { robotsUrl, fetchedAt: nowIso, rules: EMPTY_ROBOTS_RULES, unavailable: true };
  }

  if (response.status >= 200 && response.status < 300) {
    const text = await readCappedText(response, MAX_ROBOTS_BYTES);
    const rules: RobotsRules = parseRobotsTxt(text);
    return { robotsUrl, fetchedAt: nowIso, rules, unavailable: false };
  }

  if (response.status >= 400 && response.status < 500) {
    // 401/403/404 等 4xx → RFC 9309: 全許可扱い
    return { robotsUrl, fetchedAt: nowIso, rules: EMPTY_ROBOTS_RULES, unavailable: false };
  }

  // 5xx およびその他の非成功応答 → 取得不能 (disallow 扱い)
  return { robotsUrl, fetchedAt: nowIso, rules: EMPTY_ROBOTS_RULES, unavailable: true };
}

export async function checkRobots(
  originUrl: string,
  targetUrl: string,
  opts: CheckRobotsOptions = {},
): Promise<RobotsDecision> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const userAgent = opts.userAgent ?? DEFAULT_ROBOTS_USER_AGENT;
  const uaToken = opts.uaToken ?? DEFAULT_UA_TOKEN;
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_ROBOTS_TTL_SECONDS;
  const now = opts.now ?? (() => Date.now());

  const origin = new URL(originUrl).origin;
  const robotsUrl = new URL('/robots.txt', origin).toString();

  let entry: CachedRobots | null = null;
  let fromCache = false;

  if (opts.cache) {
    const cached = await opts.cache.get(origin);
    if (cached) {
      const ageMs = now() - Date.parse(cached.fetchedAt);
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ttlSeconds * 1000) {
        entry = cached;
        fromCache = true;
      }
    }
  }

  if (!entry) {
    const nowIso = new Date(now()).toISOString();
    entry = await fetchRobots(robotsUrl, fetchImpl, userAgent, nowIso);
    if (opts.cache) {
      await opts.cache.put(origin, entry);
    }
  }

  if (entry.unavailable) {
    return {
      verdict: 'disallowed',
      robotsUrl: entry.robotsUrl,
      fetchedAt: entry.fetchedAt,
      userAgentGroup: 'unavailable',
      matchedRule: null,
      unavailable: true,
      fromCache,
    };
  }

  const evaluation = evaluateRobots(entry.rules, targetUrl, uaToken);

  return {
    verdict: evaluation.verdict,
    robotsUrl: entry.robotsUrl,
    fetchedAt: entry.fetchedAt,
    userAgentGroup: evaluation.userAgentGroup,
    matchedRule: evaluation.matchedRule,
    unavailable: false,
    fromCache,
  };
}
