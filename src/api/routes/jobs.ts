/**
 * /api/jobs/:id/attempts (取得経路の再現。SPEC 目的6)
 */
import { Hono } from 'hono';
import type { Env } from '../../shared/env';
import { countCheckAttempts, getCheckJob, listCheckAttempts } from '../../db';
import { notFound } from '../errors';
import { parsePagination } from '../http';
import { serializeCheckAttempt } from '../serialize';

export function jobsRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.get('/:id/attempts', async (c) => {
    const jobId = c.req.param('id');
    const job = await getCheckJob(c.env.DB, jobId);
    if (!job) throw notFound('check_job_not_found', 'check job not found');

    const pagination = parsePagination(c);
    const attempts = await listCheckAttempts(c.env.DB, jobId, {
      limit: pagination.limit,
      offset: pagination.offset,
    });
    const total = await countCheckAttempts(c.env.DB, jobId);
    return c.json({ items: attempts.map(serializeCheckAttempt), total });
  });

  return router;
}
