/**
 * /api/sites, /api/sites/:id/fetcher-policy, /api/sites/:id/robots-overrides (SPEC §9.2, §13, ADR-0009)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../shared/env';
import type { FetcherPolicy, FetcherPolicyEntry } from '../../shared/contracts';
import type { FailureClass } from '../../shared/types';
import { validateFetcherPolicy } from '../../fetch';
import {
  countSites,
  countSourcesBySite,
  createSite,
  deleteSiteCascade,
  getFetcherPolicy,
  getRobotsPolicy,
  getSite,
  listFetchers,
  listSites,
  putFetcherPolicy,
  recordAuditEvent,
  upsertRobotsPolicy,
} from '../../db';
import { badRequest, conflict, notFound } from '../errors';
import { parsePagination, parseWith, readJsonBody } from '../http';
import { listRobotsPoliciesBySite } from '../rawQueries';
import { serializeFetcherPolicy, serializeRobotsPolicy, serializeSite } from '../serialize';

const FAILURE_CLASSES = [
  'network_error',
  'timeout',
  'http_5xx',
  'http_429',
  'http_403',
  'not_found',
  'auth_required',
  'blocked_by_robots',
  'ssrf_blocked',
  'too_large',
  'captcha_challenge',
  'invalid_content_type',
  'parse_error',
  'internal_error',
] as const satisfies readonly FailureClass[];

const createSiteSchema = z.object({
  name: z.string().min(1),
  primary_origin: z.string().url().nullable().optional(),
  canonical_origins: z.array(z.string().url()).optional(),
});

const fetcherPolicyEntrySchema = z.object({
  fetcher_id: z.string().min(1),
  proceed_on: z.array(z.enum(FAILURE_CLASSES)).optional(),
});

const fetcherPolicySchema = z.object({
  allow_list: z.array(z.string().min(1)),
  order_list: z.array(fetcherPolicyEntrySchema),
});

const robotsOverrideSchema = z.object({
  canonical_origin: z.string().url(),
  mode: z.enum(['ignore', 'enforce']),
  reason: z.string().optional(),
  confirm: z.boolean().optional(),
});

export function sitesRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.post('/', async (c) => {
    const body = parseWith(createSiteSchema, await readJsonBody(c));
    // SiteRow (DB) は primaryOrigin という単一 origin しか永続化しない (MVP スコープ)。
    // canonical_origins は primary_origin 未指定時の互換入力として先頭要素のみ採用するが、
    // 2件以上渡された場合に他の要素を無言で捨てるとデータ消失に気付けないため、
    // 複数 origin を明示的にサポートしない今は 400 で拒否する (呼び出し側に気付かせる)。
    if (!body.primary_origin && (body.canonical_origins?.length ?? 0) > 1) {
      throw badRequest(
        'multiple_canonical_origins_unsupported',
        'canonical_origins with more than one entry is not supported yet; pass a single primary_origin instead',
      );
    }
    const primaryOrigin = body.primary_origin ?? body.canonical_origins?.[0] ?? null;
    const site = await createSite(c.env.DB, { name: body.name, primaryOrigin });
    return c.json(serializeSite(site), 201);
  });

  router.get('/', async (c) => {
    const pagination = parsePagination(c);
    // D1 側で LIMIT/OFFSET する (全件ロードして in-memory で切り出すと件数に比例して
    // 遅くなる/メモリを使うため)。total は別途 COUNT(*) で取得する。
    const [sites, total] = await Promise.all([listSites(c.env.DB, pagination), countSites(c.env.DB)]);
    return c.json({ items: sites.map(serializeSite), total });
  });

  router.get('/:id', async (c) => {
    const site = await getSite(c.env.DB, c.req.param('id'));
    if (!site) throw notFound('site_not_found', 'site not found');
    return c.json(serializeSite(site));
  });

  router.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const site = await getSite(c.env.DB, id);
    if (!site) throw notFound('site_not_found', 'site not found');

    const sourceCount = await countSourcesBySite(c.env.DB, id);
    if (sourceCount > 0) {
      throw conflict('site_has_sources', '先にSourceを削除してください');
    }

    await deleteSiteCascade(c.env.DB, id);
    await recordAuditEvent(c.env.DB, {
      actor: 'admin',
      action: 'site.delete',
      subject: id,
    });

    return c.json({ deleted: true });
  });

  router.put('/:id/fetcher-policy', async (c) => {
    const siteId = c.req.param('id');
    const site = await getSite(c.env.DB, siteId);
    if (!site) throw notFound('site_not_found', 'site not found');

    const body = parseWith(fetcherPolicySchema, await readJsonBody(c));
    const policy: FetcherPolicy = {
      allowList: body.allow_list,
      orderList: body.order_list.map(
        (entry): FetcherPolicyEntry => ({
          fetcherId: entry.fetcher_id,
          proceedOn: entry.proceed_on,
        })
      ),
    };

    const validation = validateFetcherPolicy(policy);
    if (!validation.valid) {
      throw badRequest('invalid_fetcher_policy', validation.errors.join('; '));
    }

    // fetcher_policy_entries.fetcher_id は fetchers(id) への FK。マスタに無い id は
    // D1 の FK 違反 (500) になる前にここで 400 として返す。
    const known = new Set((await listFetchers(c.env.DB)).map((f) => f.id));
    const unknown = policy.allowList.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw badRequest(
        'unknown_fetcher',
        `未登録のFetcher ID: ${unknown.join(', ')} (利用可能: ${[...known].join(', ') || 'なし'})`
      );
    }

    await putFetcherPolicy(c.env.DB, siteId, policy);
    return c.json(serializeFetcherPolicy(policy));
  });

  router.get('/:id/fetcher-policy', async (c) => {
    const siteId = c.req.param('id');
    const site = await getSite(c.env.DB, siteId);
    if (!site) throw notFound('site_not_found', 'site not found');

    const policy = await getFetcherPolicy(c.env.DB, siteId);
    if (!policy) throw notFound('fetcher_policy_not_found', 'no fetcher policy configured for this site');
    return c.json(serializeFetcherPolicy(policy));
  });

  router.put('/:id/robots-overrides', async (c) => {
    const siteId = c.req.param('id');
    const site = await getSite(c.env.DB, siteId);
    if (!site) throw notFound('site_not_found', 'site not found');

    const body = parseWith(robotsOverrideSchema, await readJsonBody(c));

    if (body.mode === 'ignore') {
      if (!body.reason || body.reason.trim() === '') {
        throw badRequest('reason_required', 'reason is required when mode is "ignore"');
      }
      if (body.confirm !== true) {
        throw badRequest('confirmation_required', 'confirm must be true when mode is "ignore"');
      }
    }

    const policy = await upsertRobotsPolicy(c.env.DB, {
      siteId,
      canonicalOrigin: body.canonical_origin,
      mode: body.mode,
      reason: body.reason ?? null,
      updatedBy: 'admin',
    });

    await recordAuditEvent(c.env.DB, {
      actor: 'admin',
      action: body.mode === 'ignore' ? 'robots_override.enable' : 'robots_override.enforce',
      subject: `site:${siteId}:${body.canonical_origin}`,
      reason: body.reason ?? null,
      payload: { siteId, canonicalOrigin: body.canonical_origin, mode: body.mode },
    });

    return c.json(serializeRobotsPolicy(policy));
  });

  router.get('/:id/robots-overrides', async (c) => {
    const siteId = c.req.param('id');
    const site = await getSite(c.env.DB, siteId);
    if (!site) throw notFound('site_not_found', 'site not found');

    const policies = await listRobotsPoliciesBySite(c.env.DB, siteId);
    return c.json({
      items: policies.map(serializeRobotsPolicy),
      has_active_override: policies.some((p) => p.mode === 'ignore'),
    });
  });

  router.delete('/:id/robots-overrides', async (c) => {
    const siteId = c.req.param('id');
    const site = await getSite(c.env.DB, siteId);
    if (!site) throw notFound('site_not_found', 'site not found');

    const canonicalOrigin = c.req.query('canonical_origin');
    if (!canonicalOrigin) {
      throw badRequest('canonical_origin_required', 'canonical_origin query parameter is required');
    }

    const existing = await getRobotsPolicy(c.env.DB, siteId, canonicalOrigin);
    if (!existing) throw notFound('robots_override_not_found', 'no override found for this origin');

    const policy = await upsertRobotsPolicy(c.env.DB, {
      siteId,
      canonicalOrigin,
      mode: 'enforce',
      reason: null,
      updatedBy: 'admin',
    });

    await recordAuditEvent(c.env.DB, {
      actor: 'admin',
      action: 'robots_override.enforce',
      subject: `site:${siteId}:${canonicalOrigin}`,
      reason: null,
      payload: { siteId, canonicalOrigin, mode: 'enforce', revertedFrom: existing.mode },
    });

    return c.json(serializeRobotsPolicy(policy));
  });

  return router;
}
