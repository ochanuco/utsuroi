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
  SourceRow,
  SubscriptionRow,
} from '../db';
import type { AuditEventRow } from '../db';
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
  return {
    id: row.id,
    name: row.name,
    webhook_url_masked: maskWebhookUrl(row.webhookUrl),
    enabled: row.enabled,
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
