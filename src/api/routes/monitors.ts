/**
 * /api/monitors (SPEC §10, §11, ADR-0003)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../shared/env';
import type { MonitorControlFactory } from '../../shared/contracts';
import {
  createMonitor,
  deleteMonitorCascade,
  getMonitor,
  getRobotsEvaluation,
  getSource,
  listCheckJobsByMonitor,
  listMonitorsBySite,
  recordAuditEvent,
  setMonitorNextRun,
  updateMonitorInterval,
  updateMonitorStatus,
} from '../../db';
import { createDefaultMonitorControlFactory } from '../monitorControl';
import { badRequest, conflict, notFound } from '../errors';
import { paginate, parsePagination, parseWith, readJsonBody } from '../http';
import { serializeCheckJob, serializeMonitor } from '../serialize';

const createMonitorSchema = z.object({
  source_id: z.string().min(1),
  interval_seconds: z.number().int().positive(),
  next_run_at: z.string().nullable().optional(),
});

/** interval_seconds の許容範囲: 60秒 (1分) 〜 604800秒 (7日) */
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 604800;

// PATCH /api/monitors/:id は interval_seconds のみを更新する単一フィールドPATCH
// (destinations.update_thread_id と同じ形)。
const updateMonitorSchema = z.object({
  interval_seconds: z.number().int().min(MIN_INTERVAL_SECONDS).max(MAX_INTERVAL_SECONDS),
}).strict();

export interface MonitorsRoutesOptions {
  monitorControlFactory?: (env: Env) => MonitorControlFactory;
}

async function loadMonitorWithRobots(db: D1Database, id: string) {
  const monitor = await getMonitor(db, id);
  if (!monitor) return null;
  const robotsEvaluation = monitor.robotsEvaluationId
    ? await getRobotsEvaluation(db, monitor.robotsEvaluationId)
    : null;
  return { monitor, robotsEvaluation };
}

export function monitorsRoutes(opts: MonitorsRoutesOptions = {}) {
  const router = new Hono<{ Bindings: Env }>();
  const resolveFactory = (env: Env): MonitorControlFactory =>
    (opts.monitorControlFactory ?? createDefaultMonitorControlFactory)(env);

  router.post('/', async (c) => {
    const body = parseWith(createMonitorSchema, await readJsonBody(c));

    const source = await getSource(c.env.DB, body.source_id);
    if (!source) throw notFound('source_not_found', 'source not found');

    const monitor = await createMonitor(c.env.DB, {
      siteId: source.siteId,
      sourceId: source.id,
      intervalSeconds: body.interval_seconds,
      nextRunAt: body.next_run_at ?? null,
    });
    return c.json(serializeMonitor(monitor), 201);
  });

  router.get('/', async (c) => {
    const siteId = c.req.query('site_id');
    if (!siteId) throw badRequest('site_id_required', 'site_id query parameter is required');

    const pagination = parsePagination(c);
    const monitors = await listMonitorsBySite(c.env.DB, siteId);
    return c.json({ items: paginate(monitors, pagination).map((m) => serializeMonitor(m)), total: monitors.length });
  });

  router.get('/:id', async (c) => {
    const loaded = await loadMonitorWithRobots(c.env.DB, c.req.param('id'));
    if (!loaded) throw notFound('monitor_not_found', 'monitor not found');
    return c.json(serializeMonitor(loaded.monitor, loaded.robotsEvaluation));
  });

  router.patch('/:id', async (c) => {
    const monitorId = c.req.param('id');
    const monitor = await getMonitor(c.env.DB, monitorId);
    if (!monitor) throw notFound('monitor_not_found', 'monitor not found');

    const body = parseWith(updateMonitorSchema, await readJsonBody(c));
    const oldInterval = monitor.intervalSeconds;
    const newInterval = body.interval_seconds;

    await updateMonitorInterval(c.env.DB, monitorId, newInterval);

    // 前倒しの再スケジュールは稼働中 (active) かつ直近チェック実績がある場合のみ判定する。
    // pause/policy-stop中のmonitorや初回未実行のmonitorは interval のみ更新し、
    // next_run_at/Alarmには触れない (次回稼働開始・初回実行時に自然に反映されるため)。
    let rescheduledTo: string | null = null;
    if (monitor.status === 'active' && monitor.lastCheckedAt !== null) {
      const now = Date.now();
      const lastCheckedAtMs = new Date(monitor.lastCheckedAt).getTime();
      const candidateMs = Math.max(now, lastCheckedAtMs + newInterval * 1000);
      const currentNextRunMs = monitor.nextRunAt ? new Date(monitor.nextRunAt).getTime() : null;

      if (currentNextRunMs === null || candidateMs < currentNextRunMs) {
        const candidateIso = new Date(candidateMs).toISOString();
        await setMonitorNextRun(c.env.DB, monitorId, candidateIso);
        const control = resolveFactory(c.env)(monitorId);
        await control.schedule(candidateIso);
        rescheduledTo = candidateIso;
      }
    }

    await recordAuditEvent(c.env.DB, {
      actor: 'admin',
      action: 'monitor.update',
      subject: monitorId,
      payload: { from: oldInterval, to: newInterval, rescheduledTo },
    });

    const updated = await getMonitor(c.env.DB, monitorId);
    return c.json(serializeMonitor(updated!));
  });

  router.get('/:id/jobs', async (c) => {
    const monitorId = c.req.param('id');
    const monitor = await getMonitor(c.env.DB, monitorId);
    if (!monitor) throw notFound('monitor_not_found', 'monitor not found');

    const pagination = parsePagination(c);
    const jobs = await listCheckJobsByMonitor(c.env.DB, monitorId);
    return c.json({ items: paginate(jobs, pagination).map(serializeCheckJob), total: jobs.length });
  });

  router.post('/:id/run', async (c) => {
    const monitorId = c.req.param('id');
    const monitor = await getMonitor(c.env.DB, monitorId);
    if (!monitor) throw notFound('monitor_not_found', 'monitor not found');

    const control = resolveFactory(c.env)(monitorId);
    const result = await control.runNow();
    if (!result.started) {
      throw conflict('run_not_started', result.reason ?? 'monitor run could not be started');
    }
    return c.json({ started: true });
  });

  router.post('/:id/pause', async (c) => {
    const monitorId = c.req.param('id');
    const monitor = await getMonitor(c.env.DB, monitorId);
    if (!monitor) throw notFound('monitor_not_found', 'monitor not found');

    const control = resolveFactory(c.env)(monitorId);
    await control.pause();
    await updateMonitorStatus(c.env.DB, monitorId, 'paused');

    const updated = await getMonitor(c.env.DB, monitorId);
    return c.json(serializeMonitor(updated!));
  });

  router.post('/:id/resume', async (c) => {
    const monitorId = c.req.param('id');
    const monitor = await getMonitor(c.env.DB, monitorId);
    if (!monitor) throw notFound('monitor_not_found', 'monitor not found');

    const control = resolveFactory(c.env)(monitorId);
    await control.resume();
    await updateMonitorStatus(c.env.DB, monitorId, 'active');

    const updated = await getMonitor(c.env.DB, monitorId);
    return c.json(serializeMonitor(updated!));
  });

  router.delete('/:id', async (c) => {
    const monitorId = c.req.param('id');
    const monitor = await getMonitor(c.env.DB, monitorId);
    if (!monitor) throw notFound('monitor_not_found', 'monitor not found');

    // Alarmを取消する (Policy Stop 時の schedule(null) と同じ操作)。DO側のストレージに残る
    // スケジュール等の残骸は、対応する monitorId が呼ばれなくなる以上無害なので放置してよい
    // (DOインスタンス自体の物理削除・ストレージのpurgeは本スコープ外)。
    const control = resolveFactory(c.env)(monitorId);
    await control.schedule(null);

    await deleteMonitorCascade(c.env.DB, monitorId);

    await recordAuditEvent(c.env.DB, {
      actor: 'admin',
      action: 'monitor.delete',
      subject: monitorId,
      payload: { siteId: monitor.siteId, sourceId: monitor.sourceId },
    });

    return c.body(null, 204);
  });

  router.get('/:id/status', async (c) => {
    const monitorId = c.req.param('id');
    const monitor = await getMonitor(c.env.DB, monitorId);
    if (!monitor) throw notFound('monitor_not_found', 'monitor not found');

    const control = resolveFactory(c.env)(monitorId);
    const status = await control.getStatus();
    return c.json({
      monitor_id: status.monitorId,
      next_run_at: status.nextRunAt,
      running: status.running,
      paused: status.paused,
      last_result: status.lastResult,
    });
  });

  return router;
}
