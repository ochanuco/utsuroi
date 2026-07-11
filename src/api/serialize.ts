/**
 * DB Row (camelCase) -> API JSON (snake_case) の変換。
 * リクエストボディも snake_case (site_id, webhook_url 等) で受け付ける前提に揃える。
 */
import type {
  ChangeRow,
  CheckAttemptRow,
  CheckJobRow,
  DestinationRow,
  MonitorRow,
  RobotsEvaluationRow,
  RobotsPolicyRow,
  SiteRow,
  SnapshotRow,
  SourceRow,
  SubscriptionRow,
} from '../db';
import type { AuditEventRow } from '../db';
import { extractMaskedWebhookUrl, isEncryptedWebhookUrl } from '../db';
import type { FetcherPolicy } from '../shared/contracts';
import { maskWebhookUrl } from './mask';

export function serializeFetcherPolicy(policy: FetcherPolicy) {
  return {
    allow_list: policy.allowList,
    order_list: policy.orderList.map((entry) => ({
      fetcher_id: entry.fetcherId,
      proceed_on: entry.proceedOn ?? null,
    })),
  };
}

export function serializeSite(row: SiteRow) {
  return {
    id: row.id,
    name: row.name,
    primary_origin: row.primaryOrigin,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function serializeSource(row: SourceRow) {
  return {
    id: row.id,
    site_id: row.siteId,
    type: row.type,
    url: row.url,
    // config (ADR-0010 Phase B / ADR-0011): camelCase内部表現 -> snake_case API出力。
    // null はそのまま null (省略ではなく null passthrough で揃える)。
    config: row.config
      ? {
          sitemap_mode: row.config.sitemapMode ?? null,
          lastmod_max_age_days: row.config.lastmodMaxAgeDays ?? null,
          max_depth: row.config.maxDepth ?? null,
          page_mode: row.config.pageMode ?? null,
          extract: row.config.extract
            ? {
                item_selector: row.config.extract.itemSelector,
                link_selector: row.config.extract.linkSelector ?? null,
                title_selector: row.config.extract.titleSelector ?? null,
                // ADR-0013: 構造化フィールド抽出設定。API入力と同じ形状 (name/selector/label) の
                // ままなのでキー名の変換は不要 (null passthrough で揃える)。
                fields: row.config.extract.fields ?? null,
              }
            : null,
          ignore_selectors: row.config.ignoreSelectors ?? null,
          include_selectors: row.config.includeSelectors ?? null,
          strip_query_params: row.config.stripQueryParams ?? null,
        }
      : null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function serializeMonitor(row: MonitorRow, robotsEvaluation?: RobotsEvaluationRow | null) {
  return {
    id: row.id,
    site_id: row.siteId,
    source_id: row.sourceId,
    status: row.status,
    stop_reason: row.stopReason,
    robots_evaluation_id: row.robotsEvaluationId,
    robots_evaluation: robotsEvaluation ? serializeRobotsEvaluation(robotsEvaluation) : null,
    interval_seconds: row.intervalSeconds,
    next_run_at: row.nextRunAt,
    last_checked_at: row.lastCheckedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function serializeCheckJob(row: CheckJobRow) {
  return {
    id: row.id,
    monitor_id: row.monitorId,
    scheduled_for: row.scheduledFor,
    status: row.status,
    trigger: row.trigger,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    created_at: row.createdAt,
  };
}

export function serializeCheckAttempt(row: CheckAttemptRow) {
  return {
    id: row.id,
    check_job_id: row.checkJobId,
    target_id: row.targetId,
    fetcher_id: row.fetcherId,
    attempt_index: row.attemptIndex,
    outcome: row.outcome,
    failure_class: row.failureClass,
    status_code: row.statusCode,
    duration_ms: row.durationMs,
    snapshot_id: row.snapshotId,
    error_message: row.errorMessage,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    created_at: row.createdAt,
  };
}

export function serializeSnapshot(row: SnapshotRow) {
  return {
    id: row.id,
    monitor_id: row.monitorId,
    target_id: row.targetId,
    check_attempt_id: row.checkAttemptId,
    fetched_at: row.fetchedAt,
    http_status: row.httpStatus,
    content_type: row.contentType,
    etag: row.etag,
    last_modified: row.lastModified,
    body_hash: row.bodyHash,
    normalized_hash: row.normalizedHash,
    text_hash: row.textHash,
    normalization_version: row.normalizationVersion,
    // 生本文 (r2Key) を持つか否かのみを公開する。R2 の実キーはストレージ内部の詳細であり、
    // 外部に露出する必要がない (GET /:id/body は本 API 内部で r2Key を解決して返す)。
    has_body: row.r2Key !== null,
    has_normalized_body: row.normalizedR2Key !== null,
    created_at: row.createdAt,
  };
}

export function serializeChange(row: ChangeRow) {
  return {
    id: row.id,
    monitor_id: row.monitorId,
    target_id: row.targetId,
    target_url: row.targetUrl,
    kind: row.kind,
    diff_level: row.diffLevel,
    dedupe_key: row.dedupeKey,
    previous_snapshot_id: row.previousSnapshotId,
    snapshot_id: row.snapshotId,
    has_diff: row.diffR2Key !== null,
    diff_preview: row.diffPreview,
    title: row.title,
    detected_at: row.detectedAt,
    created_at: row.createdAt,
  };
}

export function serializeDestination(row: DestinationRow) {
  // row.webhookUrl は暗号化保存フォーマット (`enc:v1:...`, src/db/webhookCrypto.ts) が前提。
  // マスク文字列は暗号化時にその中へ埋め込み済みのため、表示のためだけに鍵で復号する必要はない。
  // 万一 (テストフィクスチャ等で) 平文が渡ってきた場合は従来通りその場でマスクする。
  // アーカイブ済み (ADR-0012) は webhook_url が空文字に破棄されており、
  // マスク表示すべき値そのものが存在しないため null を返す。
  const webhookUrlMasked = row.webhookUrl === ''
    ? null
    : isEncryptedWebhookUrl(row.webhookUrl)
      ? extractMaskedWebhookUrl(row.webhookUrl)
      : maskWebhookUrl(row.webhookUrl);
  return {
    id: row.id,
    name: row.name,
    webhook_url_masked: webhookUrlMasked,
    enabled: row.enabled,
    archived_at: row.archivedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function serializeSubscription(row: SubscriptionRow) {
  return {
    id: row.id,
    destination_id: row.destinationId,
    site_id: row.siteId,
    monitor_id: row.monitorId,
    tag: row.tag,
    kind: row.changeKind,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function serializeRobotsPolicy(row: RobotsPolicyRow) {
  return {
    id: row.id,
    site_id: row.siteId,
    canonical_origin: row.canonicalOrigin,
    mode: row.mode,
    reason: row.reason,
    updated_by: row.updatedBy,
    warning: row.mode === 'ignore',
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function serializeRobotsEvaluation(row: RobotsEvaluationRow) {
  return {
    id: row.id,
    origin: row.origin,
    verdict: row.verdict,
    robots_url: row.robotsUrl,
    checked_at: row.checkedAt,
    user_agent_group: row.userAgentGroup,
    matched_rule: row.matchedRule,
    unavailable: row.unavailable,
    robots_would_block: row.robotsWouldBlock,
    robots_hash: row.robotsHash,
    created_at: row.createdAt,
  };
}

export function serializeAuditEvent(row: AuditEventRow) {
  return {
    id: row.id,
    actor: row.actor,
    action: row.action,
    subject: row.subject,
    reason: row.reason,
    payload: row.payload,
    created_at: row.createdAt,
  };
}
