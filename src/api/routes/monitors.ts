/**
 * /api/monitors (SPEC §10, §11, ADR-0003)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../shared/env';
import type { MonitorControlFactory } from '../../shared/contracts';
import {
  createMonitor,
  getMonitor,
  getRobotsEvaluation,
  getSource,
  listCheckJobsByMonitor,
  listMonitorsBySite,
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
