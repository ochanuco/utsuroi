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

export interface SourceRow {
  id: string;
  siteId: string;
  type: SourceType;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSourceInput {
  id?: string;
  siteId: string;
  type: SourceType;
  url: string;
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
