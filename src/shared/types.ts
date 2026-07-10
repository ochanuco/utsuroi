/**
 * Utsuroi 共有ドメイン型。
 * レーン間契約: 各モジュールは自ディレクトリと src/shared/ 以外から import しない。
 */

export type SourceType = 'page' | 'rss' | 'atom' | 'sitemap' | 'sitemap-index';

export type MonitorStatus =
  | 'active'
  | 'paused'
  | 'blocked_by_robots'
  | 'failing'
  | 'archived';

/** 取得失敗の分類 (SPEC §8, ADR-0005) */
export type FailureClass =
  | 'network_error'
  | 'timeout'
  | 'http_5xx'
  | 'http_429'
  | 'http_403'
  | 'not_found' // 404, 410
  | 'auth_required' // 401, 407, 明示的な認証要求
  | 'blocked_by_robots'
  | 'ssrf_blocked'
  | 'too_large'
  | 'captcha_challenge'
  | 'invalid_content_type'
  | 'parse_error'
  | 'internal_error';

/**
 * 既定で OrderList の次候補へ進んでよい失敗分類。
 * これ以外は fetcher policy entry の proceedOn で明示された場合のみ進む。
 * blocked_by_robots / ssrf_blocked / not_found / auth_required /
 * too_large / captcha_challenge は設定によらず進まない (SPEC §8)。
 */
export const DEFAULT_PROCEEDABLE_FAILURES: readonly FailureClass[] = [
  'network_error',
  'timeout',
  'http_5xx',
];

/** 設定によらず後続 Fetcher へ進んではならない失敗分類 */
export const NEVER_PROCEEDABLE_FAILURES: readonly FailureClass[] = [
  'blocked_by_robots',
  'ssrf_blocked',
  'not_found',
  'auth_required',
  'too_large',
  'captcha_challenge',
];

export type ChangeKind = 'new' | 'updated' | 'removed';

/** 差分判定レベル (SPEC §12) */
export type DiffLevel =
  | 'http_metadata'
  | 'raw_hash'
  | 'normalized_hash'
  | 'text_hash'
  | 'structural';

export type CheckJobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'policy_stopped';

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead';

export type RobotsMode = 'enforce' | 'ignore';
