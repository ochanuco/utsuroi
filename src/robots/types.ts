/**
 * robots.txt (RFC 9309) 内部表現。
 * 契約型 (RobotsDecision 等) は src/shared/contracts.ts を参照。
 */

export interface RobotsRule {
  directive: 'allow' | 'disallow';
  /** パーセントエンコーディング正規化済みのパスパターン (declared のまま、先頭 '/' or '*') */
  pattern: string;
}

export interface RobotsGroup {
  /** 宣言された user-agent トークン (小文字化済み)。'*' も含む */
  userAgents: string[];
  rules: RobotsRule[];
}

export interface RobotsRules {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export const EMPTY_ROBOTS_RULES: RobotsRules = { groups: [], sitemaps: [] };

/** robots.txt キャッシュ1エントリ */
export interface CachedRobots {
  robotsUrl: string;
  /** 取得(または取得試行)時刻 ISO 8601 */
  fetchedAt: string;
  /** 2xx で取得できたルール。4xx (allow-all) の場合は EMPTY_ROBOTS_RULES */
  rules: RobotsRules;
  /** 5xx・ネットワークエラーで取得不能だったか (RFC 9309: disallow 扱い) */
  unavailable: boolean;
}

/** robots.txt キャッシュ。checkRobots に注入する。TTL 判定は呼び出し側 (checkRobots) が行う */
export interface RobotsCache {
  get(origin: string): Promise<CachedRobots | null>;
  put(origin: string, value: CachedRobots): Promise<void>;
}
