/**
 * レーン間契約インターフェース。
 * ここを変更できるのは親セッション（コーディネーター）のみ。
 */
import type { ChangeKind, FailureClass, SourceType } from './types';

// ---------------------------------------------------------------------------
// Fetch (src/fetch/)
// ---------------------------------------------------------------------------

export interface FetchLimits {
  /** レスポンスボディ上限バイト。超過は too_large */
  maxBytes: number;
  maxRedirects: number;
  /** 総処理時間上限 ms。超過は timeout */
  totalTimeoutMs: number;
}

export const DEFAULT_FETCH_LIMITS: FetchLimits = {
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  totalTimeoutMs: 30_000,
};

export interface FetchRequest {
  url: string;
  userAgent: string;
  headers?: Record<string, string>;
  /** 条件付きリクエスト用 */
  etag?: string | null;
  lastModified?: string | null;
  limits?: Partial<FetchLimits>;
  /** 期待する Content-Type の許可プレフィックス。空なら検証しない */
  allowedContentTypes?: string[];
}

export interface FetchSuccess {
  ok: true;
  status: number;
  /** 304 応答。body は null */
  notModified: boolean;
  finalUrl: string;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  body: Uint8Array | null;
  durationMs: number;
}

export interface FetchFailure {
  ok: false;
  failureClass: FailureClass;
  status: number | null;
  message: string;
  retryAfterSeconds: number | null;
}

export type FetchOutcome = FetchSuccess | FetchFailure;

// ---------------------------------------------------------------------------
// Fetcher Policy (src/fetch/)
// ---------------------------------------------------------------------------

export interface FetcherPolicyEntry {
  fetcherId: string;
  /**
   * このFetcherの失敗時に次候補へ進んでよい失敗分類。
   * 省略時は DEFAULT_PROCEEDABLE_FAILURES。
   * NEVER_PROCEEDABLE_FAILURES に含まれる分類は指定しても無効。
   */
  proceedOn?: FailureClass[];
}

export interface FetcherPolicy {
  allowList: string[];
  orderList: FetcherPolicyEntry[];
}

// ---------------------------------------------------------------------------
// robots.txt (src/robots/)
// ---------------------------------------------------------------------------

export type RobotsVerdict = 'allowed' | 'disallowed';

export interface RobotsDecision {
  verdict: RobotsVerdict;
  robotsUrl: string;
  fetchedAt: string; // ISO 8601
  /** マッチした User-Agent グループ ('utsuroibot' | '*' | 'unavailable' 等) */
  userAgentGroup: string;
  /** マッチしたルール行 (例: 'disallow: /private') */
  matchedRule: string | null;
  /** robots.txt が 5xx 等で取得不能 → RFC 9309 により disallow 扱い */
  unavailable: boolean;
  fromCache: boolean;
}

// ---------------------------------------------------------------------------
// SSRF (src/net/)
// ---------------------------------------------------------------------------

export interface SsrfCheckResult {
  allowed: boolean;
  reason: string | null; // 拒否理由 (loopback / private / link-local / metadata / scheme)
}

// ---------------------------------------------------------------------------
// Source Adapters (src/adapters/)
// ---------------------------------------------------------------------------

export interface FeedItem {
  /** Source内で安定な一意キー (guid > id > link > loc の優先順) */
  stableKey: string;
  url: string | null;
  title: string | null;
  publishedAt: string | null;
  updatedAt: string | null; // sitemap の lastmod もここ
  summary: string | null;
}

export interface AdapterParseResult {
  kind: SourceType;
  items: FeedItem[];
  /** sitemap-index の子 sitemap URL 一覧 */
  childSitemaps: string[];
  meta: { title: string | null };
}

// ---------------------------------------------------------------------------
// Normalization / Diff (src/normalize/)
// ---------------------------------------------------------------------------

export interface NormalizeOptions {
  /** 相対URL解決の基準 */
  baseUrl: string;
  stripScripts?: boolean; // default true
  stripStyles?: boolean; // default true
  stripComments?: boolean; // default true
  /** 除去する要素の CSS セレクタ (タグ名・#id・.class 程度の簡易セレクタ) */
  ignoreSelectors?: string[];
  /** 指定時はこのセレクタ配下のみを比較対象に抽出 */
  includeSelectors?: string[];
  /** URLから除去する tracking クエリパラメータ。省略時は既定リスト */
  stripQueryParams?: string[];
  /** 無視する動的属性名。省略時は nonce 等の既定リスト */
  dynamicAttributes?: string[];
}

export interface NormalizedContent {
  normalizedHtml: string;
  extractedText: string;
  rawHash: string; // sha-256 hex (raw body)
  normalizedHash: string; // sha-256 hex (normalizedHtml)
  textHash: string; // sha-256 hex (extractedText)
  /** 正規化ロジックの版。ロジック変更時にインクリメント */
  normalizationVersion: number;
}

export interface TextDiffResult {
  changed: boolean;
  unifiedDiff: string;
  addedCount: number;
  removedCount: number;
}

// ---------------------------------------------------------------------------
// Notification (src/notify/)
// ---------------------------------------------------------------------------

export interface NotifyQueueMessage {
  deliveryId: string;
}

export interface ChangeSummary {
  changeId: string;
  kind: ChangeKind;
  sourceType: SourceType;
  siteName: string;
  monitorId: string;
  targetUrl: string;
  title: string | null;
  detectedAt: string; // ISO 8601
  /** 通知に載せる差分プレビュー (切り詰め済み) */
  diffPreview: string | null;
}

export interface PendingDelivery {
  deliveryId: string;
  change: ChangeSummary;
  webhookUrl: string;
  attemptCount: number;
}

/**
 * 配送状態ストア。実装は src/db/ (Lane A)、消費は src/notify/ (Lane E)。
 * Lane E はテストではインメモリフェイクを使う。
 */
export interface NotifyStore {
  /** 配送すべき delivery を返す。配送済み・不明IDは null (冪等性の要) */
  getPendingDelivery(deliveryId: string): Promise<PendingDelivery | null>;
  markDelivered(deliveryId: string): Promise<void>;
  markFailed(deliveryId: string, error: string, opts: { dead: boolean }): Promise<void>;
}

/** Discord送信の結果。429は retryAfterSeconds を必ず持つ */
export type DiscordSendResult =
  | { ok: true }
  | { ok: false; status: number | null; retryAfterSeconds: number | null; message: string };
