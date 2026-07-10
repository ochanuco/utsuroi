import { describe, expect, it } from 'vitest';
import {
  createCheckAttempt,
  createCheckJobIfNew,
  listCheckAttempts,
  listCheckJobsByMonitor,
  updateCheckJobStatus,
} from '../../src/db';
import { buildFixture, db } from './helpers';

describe('check_jobs idempotency (SPEC §10, §17.7: no duplicate job launches)', () => {
  it('does not duplicate-launch the same monitor for the same scheduled_for', async () => {
    const d = db();
    const { monitor } = await buildFixture(d);
    const scheduledFor = '2026-07-10T00:00:00.000Z';

    const first = await createCheckJobIfNew(d, { monitorId: monitor.id, scheduledFor });
    expect(first.inserted).toBe(true);

    // Alarm re-fires or cron reconciliation double-schedules the same slot
    const second = await createCheckJobIfNew(d, { monitorId: monitor.id, scheduledFor });
    expect(second.inserted).toBe(false);
    expect(second.row.id).toBe(first.row.id);

    const jobs = await listCheckJobsByMonitor(d, monitor.id);
    expect(jobs).toHaveLength(1);
  });

  it('allows a different scheduled_for for the same monitor', async () => {
    const d = db();
    const { monitor } = await buildFixture(d);
    const a = await createCheckJobIfNew(d, { monitorId: monitor.id, scheduledFor: '2026-07-10T00:00:00.000Z' });
    const b = await createCheckJobIfNew(d, { monitorId: monitor.id, scheduledFor: '2026-07-10T01:00:00.000Z' });
    expect(a.row.id).not.toBe(b.row.id);
  });

  it('tracks status transitions and attempts', async () => {
    const d = db();
    const { monitor, target } = await buildFixture(d);
    const job = await createCheckJobIfNew(d, {
      monitorId: monitor.id,
      scheduledFor: '2026-07-10T02:00:00.000Z',
    });
    await updateCheckJobStatus(d, job.row.id, 'running', { startedAt: '2026-07-10T02:00:01.000Z' });

    const executor = await d
      .prepare(`INSERT INTO executors (id, kind, name, status, created_at, updated_at) VALUES (?, 'cloudflare', 'CF', 'active', ?, ?)`)
      .bind('exec-1', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
      .run();
    expect(executor.success).toBe(true);
    await d
      .prepare(
        `INSERT INTO fetchers (id, executor_id, fetch_mode, created_at, updated_at) VALUES ('fetcher-1', 'exec-1', 'http', ?, ?)`
      )
      .bind('2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
      .run();

    await createCheckAttempt(d, {
      checkJobId: job.row.id,
      targetId: target.id,
      fetcherId: 'fetcher-1',
      attemptIndex: 0,
      outcome: 'success',
      statusCode: 200,
    });

    await updateCheckJobStatus(d, job.row.id, 'succeeded', { finishedAt: '2026-07-10T02:00:02.000Z' });

    const attempts = await listCheckAttempts(d, job.row.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('success');

    const jobs = await listCheckJobsByMonitor(d, monitor.id);
    const updatedJob = jobs.find((j) => j.id === job.row.id);
    expect(updatedJob?.status).toBe('succeeded');
    expect(updatedJob?.startedAt).toBe('2026-07-10T02:00:01.000Z');
    expect(updatedJob?.finishedAt).toBe('2026-07-10T02:00:02.000Z');
  });
});
