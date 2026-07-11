/**
 * Utsuroi D1 ストア層の公開型。
 * wave2 (パイプライン・API) はこのファイル (と src/db/index.ts 経由) の型のみを参照する。
 *
 * 命名規約: DB列は snake_case、TS の Row/Input 型は camelCase。
 * 変換は各 src/db/*.ts 内の row マッピング関数が担う。
 */
import type {
  ChangeKind,
  CheckJobStatus,
  DeliveryStatus,
  DiffLevel,
  FailureClass,
  MonitorStatus,
  RobotsMode,
  SourceType,
} from '../shared/types';
import type { RobotsVerdict } from '../shared/contracts';

// ---------------------------------------------------------------------------
// sites / sources / monitors
// ---------------------------------------------------------------------------

export interface SiteRow {
  id: string;
  name: string;
  primaryOrigin: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSiteInput {
  id?: string;
  name: string;
  primaryOrigin?: string | null;
}

/**
 * Source の任意設定 (migrations/0002_wave2.sql の sources.config 列)。
 * sitemap系キー (sitemapMode/lastmodMaxAgeDays/maxDepth, ADR-0010 Phase B) は
 * sitemap/sitemap-index Source にのみ、page系キー (ignoreSelectors/includeSelectors/
 * stripQueryParams/pageMode/extract, ADR-0011) は page Source にのみ意味を持つ。
 * どちらも他の SourceType では常に null (src/api/routes/sources.ts が type 別に検証・拒否する)。
 */
export interface SourceConfig {
  /** 既定 'direct' (ADR-0010 モードA)。'traverse' で lastmodベース探索 (モードB) を有効化する */
  sitemapMode?: 'direct' | 'traverse';
  /** traverse モードの lastmod 足切り日数 (既定 DEFAULT_LASTMOD_MAX_AGE_DAYS) */
  lastmodMaxAgeDays?: number;
  /** traverse モードの sitemap-index 再帰深さ上限 (既定 DEFAULT_MAX_TRAVERSAL_DEPTH) */
  maxDepth?: number;
  /** page Source の正規化オプション (src/normalize/normalize.ts へそのまま渡す, ADR-0011 以前から存在) */
  ignoreSelectors?: string[];
  includeSelectors?: string[];
  stripQueryParams?: string[];
  /** page Source の監視方式。既定 'content' (本文差分)。'extract' で ADR-0011 のアイテム抽出モード */
  pageMode?: 'content' | 'extract';
  /** pageMode === 'extract' のときの抽出設定 (ADR-0011) */
  extract?: {
    /** アイテム集合を区切る CSS セレクタ (必須, 例: '.property_unit') */
    itemSelector: string;
    /** アイテム内でリンクを探す CSS セレクタ (既定 'a') */
    linkSelector?: string;
    /** アイテム内でタイトルを探す CSS セレクタ (省略時はリンクテキストにフォールバック) */
    titleSelector?: string;
  };
}

export interface SourceRow {
  id: string;
  siteId: string;
  type: SourceType;
  url: string;
  config: SourceConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSourceInput {
  id?: string;
  siteId: string;
  type: SourceType;
  url: string;
  config?: SourceConfig;
}

export interface MonitorRow {
  id: string;
  siteId: string;
  sourceId: string;
  status: MonitorStatus;
  stopReason: string | null;
  robotsEvaluationId: string | null;
  intervalSeconds: number;
  nextRunAt: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMonitorInput {
  id?: string;
  siteId: string;
  sourceId: string;
  status?: MonitorStatus;
  intervalSeconds: number;
  nextRunAt?: string | null;
}

// ---------------------------------------------------------------------------
// executors / fetchers / fetcher policy
// ---------------------------------------------------------------------------

export interface ExecutorRow {
  id: string;
  kind: string;
  name: string;
  capabilities: string | null; // raw JSON string
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateExecutorInput {
  id?: string;
  kind: string;
  name: string;
  capabilities?: unknown;
  status?: string;
}

export interface FetcherRow {
  id: string;
  executorId: string;
  fetchMode: 'http' | 'browser';
  region: string | null;
  profile: string | null; // raw JSON string
  createdAt: string;
  updatedAt: string;
}

export interface CreateFetcherInput {
  id: string; // logical fetcher id, e.g. 'cf-http-apac'
  executorId: string;
  fetchMode: 'http' | 'browser';
  region?: string | null;
  profile?: unknown;
}

// ---------------------------------------------------------------------------
// targets / check jobs / check attempts
// ---------------------------------------------------------------------------

export interface TargetRow {
  id: string;
  monitorId: string;
  url: string;
  discoveredFrom: string | null;
  firstSeenAt: string;
  lastCheckedAt: string | null;
  /**
   * feed/sitemap item の最後に観測した updatedAt (lastmod/atom updated) の watermark。
   * 'updated' Change の生成可否を、Change テーブルの dedupeKey 存在有無ではなくこの値との
   * 直接比較で判定するために使う (migrations/0005_target_updated_watermark.sql)。
   * updatedAt を持たない Source (rss 等) や、まだ観測が無い場合は null。
   */
  lastKnownUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTargetInput {
  id?: string;
  monitorId: string;
  url: string;
  discoveredFrom?: string | null;
  firstSeenAt?: string;
  /** upsert 時に item.updatedAt を watermark として記録したい場合に渡す (省略時は更新しない) */
  lastKnownUpdatedAt?: string | null;
}

export interface CheckJobRow {
  id: string;
  monitorId: string;
  scheduledFor: string;
  status: CheckJobStatus;
  trigger: 'scheduled' | 'manual' | 'reconciliation';
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface CreateCheckJobInput {
  id?: string;
  monitorId: string;
  scheduledFor: string;
  status?: CheckJobStatus;
  trigger?: 'scheduled' | 'manual' | 'reconciliation';
}

export interface CheckAttemptRow {
  id: string;
  checkJobId: string;
  targetId: string;
  fetcherId: string;
  attemptIndex: number;
  outcome: 'success' | 'failure';
  failureClass: FailureClass | null;
  statusCode: number | null;
  durationMs: number | null;
  snapshotId: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
}

export interface CreateCheckAttemptInput {
  id?: string;
  checkJobId: string;
  targetId: string;
  fetcherId: string;
  attemptIndex: number;
  outcome: 'success' | 'failure';
  failureClass?: FailureClass | null;
  statusCode?: number | null;
  durationMs?: number | null;
  snapshotId?: string | null;
  errorMessage?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
}

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

export interface SnapshotRow {
  id: string;
  monitorId: string;
  targetId: string;
  checkAttemptId: string | null;
  fetchedAt: string;
  httpStatus: number | null;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  bodyHash: string | null;
  r2Key: string | null;
  normalizedHash: string | null;
  normalizedR2Key: string | null;
  textHash: string | null;
  normalizationVersion: number | null;
  createdAt: string;
}

export interface CreateSnapshotInput {
  id?: string;
  monitorId: string;
  targetId: string;
  checkAttemptId?: string | null;
  fetchedAt?: string;
  httpStatus?: number | null;
  contentType?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  bodyHash?: string | null;
  r2Key?: string | null;
  normalizedHash?: string | null;
  normalizedR2Key?: string | null;
  textHash?: string | null;
  normalizationVersion?: number | null;
}

// ---------------------------------------------------------------------------
// changes
// ---------------------------------------------------------------------------

export interface ChangeRow {
  id: string;
  monitorId: string;
  targetId: string | null;
  targetUrl: string;
  kind: ChangeKind;
  diffLevel: DiffLevel | null;
  dedupeKey: string;
  previousSnapshotId: string | null;
  snapshotId: string | null;
  diffR2Key: string | null;
  diffPreview: string | null;
  title: string | null;
  detectedAt: string;
  createdAt: string;
}

export interface CreateChangeInput {
  id?: string;
  monitorId: string;
  targetId?: string | null;
  targetUrl: string;
  kind: ChangeKind;
  diffLevel?: DiffLevel | null;
  /** ページ変更: content hash 由来 / feed entry: stable_key 由来。UNIQUE(monitor_id, dedupe_key) */
  dedupeKey: string;
  previousSnapshotId?: string | null;
  snapshotId?: string | null;
  diffR2Key?: string | null;
  diffPreview?: string | null;
  title?: string | null;
  detectedAt?: string;
}

/** insertChangeIfNew の戻り値。inserted=false は既存重複 (冪等) */
export interface InsertResult<T> {
  inserted: boolean;
  row: T;
}

// ---------------------------------------------------------------------------
// destinations / subscriptions / deliveries
// ---------------------------------------------------------------------------

export interface DestinationRow {
  id: string;
  name: string;
  webhookUrl: string;
  enabled: boolean;
  /** アーカイブ (soft delete, ADR-0012) 日時。未アーカイブなら null */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDestinationInput {
  id?: string;
  name: string;
  webhookUrl: string;
  enabled?: boolean;
}

export interface SubscriptionRow {
  id: string;
  destinationId: string;
  siteId: string | null;
  monitorId: string | null;
  tag: string | null;
  changeKind: ChangeKind | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSubscriptionInput {
  id?: string;
  destinationId: string;
  siteId?: string | null;
  monitorId?: string | null;
  tag?: string | null;
  changeKind?: ChangeKind | null;
}

export interface DeliveryRow {
  id: string;
  changeId: string;
  destinationId: string;
  status: DeliveryStatus;
  attemptCount: number;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

export interface RobotsPolicyRow {
  id: string;
  siteId: string;
  canonicalOrigin: string;
  mode: RobotsMode;
  reason: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertRobotsPolicyInput {
  siteId: string;
  canonicalOrigin: string;
  mode: RobotsMode;
  reason?: string | null;
  updatedBy?: string | null;
}

export interface RobotsEvaluationRow {
  id: string;
  origin: string;
  verdict: RobotsVerdict;
  robotsUrl: string;
  checkedAt: string;
  userAgentGroup: string;
  matchedRule: string | null;
  unavailable: boolean;
  robotsWouldBlock: boolean;
  robotsHash: string | null;
  createdAt: string;
}

export interface CreateRobotsEvaluationInput {
  id?: string;
  origin: string;
  verdict: RobotsVerdict;
  robotsUrl: string;
  checkedAt?: string;
  userAgentGroup: string;
  matchedRule?: string | null;
  unavailable?: boolean;
  robotsWouldBlock?: boolean;
  robotsHash?: string | null;
}

// ---------------------------------------------------------------------------
// audit_events
// ---------------------------------------------------------------------------

export interface AuditEventRow {
  id: string;
  actor: string;
  action: string;
  subject: string;
  reason: string | null;
  payload: unknown;
  createdAt: string;
}

export interface CreateAuditEventInput {
  id?: string;
  actor: string;
  action: string;
  subject: string;
  reason?: string | null;
  payload?: unknown;
}
