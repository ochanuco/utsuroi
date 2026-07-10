import { describe, expect, it } from 'vitest';
import {
  createCheckAttempt,
  createCheckJobIfNew,
  createDeliveryIfNew,
  createRobotsEvaluation,
  createSnapshot,
  createSubscription,
  deleteMonitorCascade,
  getMonitor,
  insertChangeIfNew,
  policyStopMonitor,
  updateMonitorStatus,
} from '../../src/db';
import { buildFixture, db } from './helpers';

/** monitorId に紐づく行が1件も残っていないことを確認する小さなヘルパー */
async function countRows(d: D1Database, table: string, column: string, id: string): Promise<number> {
  const row = await d
    .prepare(`SELECT COUNT(*) as count FROM ${table} WHERE ${column} = ?`)
    .bind(id)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

describe('monitors policy stop (SPEC §9, ADR-0008: blocked_by_robots)', () => {
  it('stops a monitor with stop_reason and robots_evaluation_id, clearing next_run_at', async () => {
    const d = db();
    const { monitor } = await buildFixture(d);
    const evaluation = await createRobotsEvaluation(d, {
      origin: 'https://example.com',
      verdict: 'disallowed',
      robotsUrl: 'https://example.com/robots.txt',
      userAgentGroup: 'utsuroibot',
      matchedRule: 'disallow: /',
    });

    await policyStopMonitor(d, monitor.id, {
      stopReason: 'blocked_by_robots: disallow: /',
      robotsEvaluationId: evaluation.id,
    });

    const stopped = await getMonitor(d, monitor.id);
    expect(stopped?.status).toBe('blocked_by_robots');
    expect(stopped?.stopReason).toBe('blocked_by_robots: disallow: /');
    expect(stopped?.robotsEvaluationId).toBe(evaluation.id);
    expect(stopped?.nextRunAt).toBeNull();
  });

  it('clears stop_reason/robots_evaluation_id when the monitor is resumed', async () => {
    const d = db();
    const { monitor } = await buildFixture(d);
    const evaluation = await createRobotsEvaluation(d, {
      origin: 'https://example.com',
      verdict: 'disallowed',
      robotsUrl: 'https://example.com/robots.txt',
      userAgentGroup: 'utsuroibot',
    });
    await policyStopMonitor(d, monitor.id, { stopReason: 'blocked', robotsEvaluationId: evaluation.id });

    await updateMonitorStatus(d, monitor.id, 'active');

    const resumed = await getMonitor(d, monitor.id);
    expect(resumed?.status).toBe('active');
    expect(resumed?.stopReason).toBeNull();
    expect(resumed?.robotsEvaluationId).toBeNull();
  });
});

describe('deleteMonitorCascade (Site/Source/Monitor削除機能, D1 FK制約に沿った完全カスケード)', () => {
  it('removes deliveries/changes/check_attempts/check_jobs/snapshots/targets/subscriptions and the monitor itself without an FK violation', async () => {
    const d = db();
    const { monitor, target, destination } = await buildFixture(d);

    const executorId = crypto.randomUUID();
    const fetcherId = crypto.randomUUID();
    const now = new Date().toISOString();
    await d
      .prepare(
        `INSERT INTO executors (id, kind, name, status, created_at, updated_at) VALUES (?, 'cloudflare', 'CF', 'active', ?, ?)`
      )
      .bind(executorId, now, now)
      .run();
    await d
      .prepare(
        `INSERT INTO fetchers (id, executor_id, fetch_mode, created_at, updated_at) VALUES (?, ?, 'http', ?, ?)`
      )
      .bind(fetcherId, executorId, now, now)
      .run();

    const job = await createCheckJobIfNew(d, { monitorId: monitor.id, scheduledFor: now });
    const attempt = await createCheckAttempt(d, {
      checkJobId: job.row.id,
      targetId: target.id,
      fetcherId,
      attemptIndex: 0,
      outcome: 'success',
      statusCode: 200,
    });
    const snapshot = await createSnapshot(d, {
      monitorId: monitor.id,
      targetId: target.id,
      checkAttemptId: attempt.id,
      httpStatus: 200,
    });
    // check_attempts.snapshot_id / changes.snapshot_id はいずれも snapshots(id) への nullable FK。
    // 実パイプラインを模して両方から snapshot を参照させ、削除順序が正しくないと
    // FOREIGN KEY 制約違反になることを確認する。
    await d.prepare(`UPDATE check_attempts SET snapshot_id = ? WHERE id = ?`).bind(snapshot.id, attempt.id).run();
    const change = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'new',
      dedupeKey: 'dedupe-cascade-test',
      snapshotId: snapshot.id,
    });
    await createDeliveryIfNew(d, change.row.id, destination.id);
    const subscription = await createSubscription(d, { destinationId: destination.id, monitorId: monitor.id });

    const deleted = await deleteMonitorCascade(d, monitor.id);
    expect(deleted).toBe(true);

    expect(await getMonitor(d, monitor.id)).toBeNull();
    expect(await countRows(d, 'deliveries', 'change_id', change.row.id)).toBe(0);
    expect(await countRows(d, 'changes', 'monitor_id', monitor.id)).toBe(0);
    expect(await countRows(d, 'check_attempts', 'check_job_id', job.row.id)).toBe(0);
    expect(await countRows(d, 'check_jobs', 'monitor_id', monitor.id)).toBe(0);
    expect(await countRows(d, 'snapshots', 'monitor_id', monitor.id)).toBe(0);
    expect(await countRows(d, 'targets', 'monitor_id', monitor.id)).toBe(0);
    expect(await countRows(d, 'subscriptions', 'id', subscription.id)).toBe(0);
  });

  it('returns false and changes nothing for an unknown monitor id', async () => {
    const d = db();
    expect(await deleteMonitorCascade(d, 'does-not-exist')).toBe(false);
  });
});
