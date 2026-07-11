/**
 * /api/sources (SPEC §15 SSRF検査、URL登録時)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../shared/env';
import type { DnsResolver } from '../../net';
import { checkUrlForSsrf, resolveAndCheck } from '../../net';
import {
  countMonitorsBySource,
  countSourcesBySite,
  createSource,
  deleteSource,
  getSite,
  getSource,
  listSourcesBySite,
  recordAuditEvent,
  type SourceConfig,
} from '../../db';
import { badRequest, conflict, notFound } from '../errors';
import { parsePagination, parseWith, readJsonBody } from '../http';
import { serializeSource } from '../serialize';

// ADR-0010 Phase B: sitemap / sitemap-index Source のみ config を受け付ける (他typeは400)。
const sourceConfigSchema = z
  .object({
    sitemap_mode: z.enum(['direct', 'traverse']).optional(),
    lastmod_max_age_days: z.number().int().min(1).max(30).optional(),
    max_depth: z.number().int().min(1).max(5).optional(),
  })
  .strict()
  .optional();

const createSourceSchema = z.object({
  site_id: z.string().min(1),
  type: z.enum(['page', 'rss', 'atom', 'sitemap', 'sitemap-index']),
  url: z.string().min(1),
  config: sourceConfigSchema,
});

/** snake_case (API入力) -> camelCase (SourceConfig) */
function toSourceConfig(input: z.infer<typeof createSourceSchema>['config']): SourceConfig | undefined {
  if (!input) return undefined;
  const config: SourceConfig = {};
  if (input.sitemap_mode !== undefined) config.sitemapMode = input.sitemap_mode;
  if (input.lastmod_max_age_days !== undefined) config.lastmodMaxAgeDays = input.lastmod_max_age_days;
  if (input.max_depth !== undefined) config.maxDepth = input.max_depth;
  return config;
}

export function sourcesRoutes(opts: { ssrfResolver?: DnsResolver } = {}) {
  const router = new Hono<{ Bindings: Env }>();

  router.post('/', async (c) => {
    const body = parseWith(createSourceSchema, await readJsonBody(c));

    const site = await getSite(c.env.DB, body.site_id);
    if (!site) throw notFound('site_not_found', 'site not found');

    const staticCheck = checkUrlForSsrf(body.url);
    if (!staticCheck.allowed) {
      throw badRequest('ssrf_blocked', `url rejected by SSRF check: ${staticCheck.reason}`);
    }

    const resolvedCheck = await resolveAndCheck(body.url, { resolver: opts.ssrfResolver });
    if (!resolvedCheck.allowed) {
      throw badRequest('ssrf_blocked', `url rejected by SSRF check: ${resolvedCheck.reason}`);
    }

    if (body.config && body.type !== 'sitemap' && body.type !== 'sitemap-index') {
      throw badRequest('config_not_applicable', 'config is only applicable to sitemap/sitemap-index sources');
    }

    const source = await createSource(c.env.DB, {
      siteId: body.site_id,
      type: body.type,
      url: body.url,
      config: toSourceConfig(body.config),
    });
    return c.json(serializeSource(source), 201);
  });

  router.get('/:id', async (c) => {
    const source = await getSource(c.env.DB, c.req.param('id'));
    if (!source) throw notFound('source_not_found', 'source not found');
    return c.json(serializeSource(source));
  });

  router.get('/', async (c) => {
    const siteId = c.req.query('site_id');
    if (!siteId) throw badRequest('site_id_required', 'site_id query parameter is required');

    const site = await getSite(c.env.DB, siteId);
    if (!site) throw notFound('site_not_found', 'site not found');

    const pagination = parsePagination(c);
    const sources = await listSourcesBySite(c.env.DB, siteId, {
      limit: pagination.limit,
      offset: pagination.offset,
    });
    const total = await countSourcesBySite(c.env.DB, siteId);
    return c.json({ items: sources.map(serializeSource), total });
  });

  router.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const source = await getSource(c.env.DB, id);
    if (!source) throw notFound('source_not_found', 'source not found');

    const monitorCount = await countMonitorsBySource(c.env.DB, id);
    if (monitorCount > 0) {
      throw conflict('source_has_monitors', '先にMonitorを削除してください');
    }

    await deleteSource(c.env.DB, id);
    await recordAuditEvent(c.env.DB, {
      actor: 'admin',
      action: 'source.delete',
      subject: id,
      payload: { siteId: source.siteId },
    });

    return c.json({ deleted: true });
  });

  return router;
}
