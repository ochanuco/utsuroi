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

// ADR-0010 Phase B (sitemap系) + ADR-0011 (page系) の config を1つのスキーマで受け付ける。
// どのキーがどの type に適用可能かは type別に分離してルートハンドラ側で検証する
// (SITEMAP_ONLY_CONFIG_KEYS / PAGE_ONLY_CONFIG_KEYS 参照) — zod の discriminated union で
// type ごとに別スキーマに分けると、type 自体のバリデーションエラーと config_not_applicable の
// 400 を作り分けにくくなるため (前者は invalid type 400、後者は「type と config の組み合わせ」
// 400 であり、意味の異なるエラーを明確に区別したい)。
const extractConfigSchema = z
  .object({
    item_selector: z.string().min(1),
    link_selector: z.string().min(1).optional(),
    title_selector: z.string().min(1).optional(),
  })
  .strict();

const sourceConfigSchema = z
  .object({
    // sitemap / sitemap-index 専用 (ADR-0010 Phase B)
    sitemap_mode: z.enum(['direct', 'traverse']).optional(),
    lastmod_max_age_days: z.number().int().min(1).max(30).optional(),
    max_depth: z.number().int().min(1).max(5).optional(),
    // page 専用 (ADR-0011 + 既存の normalize オプション)
    page_mode: z.enum(['content', 'extract']).optional(),
    extract: extractConfigSchema.optional(),
    ignore_selectors: z.array(z.string().min(1)).optional(),
    include_selectors: z.array(z.string().min(1)).optional(),
    strip_query_params: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .optional();

const createSourceSchema = z.object({
  site_id: z.string().min(1),
  type: z.enum(['page', 'rss', 'atom', 'sitemap', 'sitemap-index']),
  url: z.string().min(1),
  config: sourceConfigSchema,
});

type SourceConfigInput = NonNullable<z.infer<typeof createSourceSchema>['config']>;

/** sitemap/sitemap-index にのみ適用可能な config キー (ADR-0010 Phase B) */
const SITEMAP_ONLY_CONFIG_KEYS: Array<keyof SourceConfigInput> = [
  'sitemap_mode',
  'lastmod_max_age_days',
  'max_depth',
];
/** page にのみ適用可能な config キー (ADR-0011 + 既存の normalize オプション) */
const PAGE_ONLY_CONFIG_KEYS: Array<keyof SourceConfigInput> = [
  'page_mode',
  'extract',
  'ignore_selectors',
  'include_selectors',
  'strip_query_params',
];

/** config に含まれるキーのうち、渡された許可リストに含まれない (=type非対応の) キー名を返す */
function findConfigNotApplicableKeys(
  config: SourceConfigInput,
  allowedKeys: Array<keyof SourceConfigInput>,
): string[] {
  const allowed = new Set(allowedKeys);
  return Object.keys(config).filter((key) => !allowed.has(key as keyof SourceConfigInput));
}

/**
 * extract.item_selector が lol-html のセレクタとしてパース可能かを検証する。
 * new HTMLRewriter().on(selector, handlers) は不正なセレクタに対して同期的に throw する
 * (workerd 実測、docs/adr/0011-page-item-extraction.md 参照)。ハンドラは実行されないため
 * 空オブジェクトで十分。
 */
function isValidRewriterSelector(selector: string): boolean {
  try {
    new HTMLRewriter().on(selector, {});
    return true;
  } catch {
    return false;
  }
}

/** snake_case (API入力) -> camelCase (SourceConfig) */
function toSourceConfig(input: SourceConfigInput | undefined): SourceConfig | undefined {
  if (!input) return undefined;
  const config: SourceConfig = {};
  if (input.sitemap_mode !== undefined) config.sitemapMode = input.sitemap_mode;
  if (input.lastmod_max_age_days !== undefined) config.lastmodMaxAgeDays = input.lastmod_max_age_days;
  if (input.max_depth !== undefined) config.maxDepth = input.max_depth;
  if (input.page_mode !== undefined) config.pageMode = input.page_mode;
  if (input.extract !== undefined) {
    config.extract = {
      itemSelector: input.extract.item_selector,
      ...(input.extract.link_selector !== undefined ? { linkSelector: input.extract.link_selector } : {}),
      ...(input.extract.title_selector !== undefined ? { titleSelector: input.extract.title_selector } : {}),
    };
  }
  if (input.ignore_selectors !== undefined) config.ignoreSelectors = input.ignore_selectors;
  if (input.include_selectors !== undefined) config.includeSelectors = input.include_selectors;
  if (input.strip_query_params !== undefined) config.stripQueryParams = input.strip_query_params;
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

    if (body.config) {
      if (body.type === 'sitemap' || body.type === 'sitemap-index') {
        const badKeys = findConfigNotApplicableKeys(body.config, SITEMAP_ONLY_CONFIG_KEYS);
        if (badKeys.length > 0) {
          throw badRequest(
            'config_not_applicable',
            `config key(s) not applicable to ${body.type} sources: ${badKeys.join(', ')}`,
          );
        }
      } else if (body.type === 'page') {
        const badKeys = findConfigNotApplicableKeys(body.config, PAGE_ONLY_CONFIG_KEYS);
        if (badKeys.length > 0) {
          throw badRequest(
            'config_not_applicable',
            `config key(s) not applicable to page sources: ${badKeys.join(', ')}`,
          );
        }
      } else {
        // rss/atom は config を一切受け付けない (従来どおり)。
        throw badRequest(
          'config_not_applicable',
          `config is not applicable to ${body.type} sources`,
        );
      }
    }

    if (body.type === 'page' && body.config?.page_mode === 'extract' && !body.config.extract?.item_selector) {
      throw badRequest('invalid_selector', 'extract.item_selector is required when page_mode is "extract"');
    }
    // item/link/title の3セレクタとも lol-html でパース可能かを作成時に検証する。不正な
    // link_selector/title_selector を通すと、抽出実行時 (extractItems の HTMLRewriter.on) に
    // throw して毎チェック失敗し続けるため、ここで弾く (レビュー指摘)。
    if (body.config?.extract) {
      const selectorFields = [
        ['item_selector', body.config.extract.item_selector],
        ['link_selector', body.config.extract.link_selector],
        ['title_selector', body.config.extract.title_selector],
      ] as const;
      for (const [field, selector] of selectorFields) {
        if (selector !== undefined && !isValidRewriterSelector(selector)) {
          throw badRequest('invalid_selector', `extract.${field} is not a valid selector: ${selector}`);
        }
      }
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
