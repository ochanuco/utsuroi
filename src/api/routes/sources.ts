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
  updateSourceConfig,
  type SourceConfig,
  type SourceRow,
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
// ADR-0013: extract.fields の1要素。selector/label のどちらか一方だけが必須という制約は
// zod (.refine 等) では invalid_field という専用エラーコードを付けにくいため、ここでは形状の
// みを検証し、「どちらか一方」の検証はルートハンドラ側 (validateSourceConfig) で行う。
const extractFieldSchema = z
  .object({
    name: z.string().min(1).max(50),
    selector: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
  })
  .strict();

const extractConfigSchema = z
  .object({
    item_selector: z.string().min(1),
    link_selector: z.string().min(1).optional(),
    title_selector: z.string().min(1).optional(),
    fields: z.array(extractFieldSchema).max(12).optional(),
  })
  .strict();

// config の中身の形状のみを定義する (optional() は create/update それぞれの呼び出し側で付与する:
// create は config キー自体を省略可能、update (PATCH) は config キーを必須にしたいため)。
const sourceConfigShape = z
  .object({
    // sitemap / sitemap-index 専用 (ADR-0010 Phase B)
    sitemap_mode: z.enum(['direct', 'traverse']).optional(),
    lastmod_max_age_days: z.number().int().min(1).max(30).optional(),
    max_depth: z.number().int().min(1).max(5).optional(),
    // sitemap / sitemap-index 専用、traverseモードでのみ意味を持つ (ADR-0015)。
    child_include_patterns: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
    // page 専用 (ADR-0011 + 既存の normalize オプション)
    page_mode: z.enum(['content', 'extract']).optional(),
    extract: extractConfigSchema.optional(),
    ignore_selectors: z.array(z.string().min(1)).optional(),
    include_selectors: z.array(z.string().min(1)).optional(),
    strip_query_params: z.array(z.string().min(1)).optional(),
  })
  .strict();

const sourceConfigSchema = sourceConfigShape.optional();

const createSourceSchema = z.object({
  site_id: z.string().min(1),
  type: z.enum(['page', 'rss', 'atom', 'sitemap', 'sitemap-index']),
  url: z.string().min(1),
  config: sourceConfigSchema,
});

// PATCH /api/sources/:id: url/type/site_id は変更不可、config のみ受け付ける
// (config キー自体は必須。空オブジェクト {} を渡すと config を丸ごとクリアする置き換え意味論)。
const updateSourceConfigSchema = z.object({ config: sourceConfigShape }).strict();

type SourceConfigInput = NonNullable<z.infer<typeof createSourceSchema>['config']>;

/** sitemap/sitemap-index にのみ適用可能な config キー (ADR-0010 Phase B, ADR-0015) */
const SITEMAP_ONLY_CONFIG_KEYS: Array<keyof SourceConfigInput> = [
  'sitemap_mode',
  'lastmod_max_age_days',
  'max_depth',
  'child_include_patterns',
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
  if (input.child_include_patterns !== undefined) config.childIncludePatterns = input.child_include_patterns;
  if (input.page_mode !== undefined) config.pageMode = input.page_mode;
  if (input.extract !== undefined) {
    config.extract = {
      itemSelector: input.extract.item_selector,
      ...(input.extract.link_selector !== undefined ? { linkSelector: input.extract.link_selector } : {}),
      ...(input.extract.title_selector !== undefined ? { titleSelector: input.extract.title_selector } : {}),
      ...(input.extract.fields !== undefined ? { fields: input.extract.fields } : {}),
    };
  }
  if (input.ignore_selectors !== undefined) config.ignoreSelectors = input.ignore_selectors;
  if (input.include_selectors !== undefined) config.includeSelectors = input.include_selectors;
  if (input.strip_query_params !== undefined) config.stripQueryParams = input.strip_query_params;
  return config;
}

/**
 * type別の許可キー検証 + セレクタ検証。POST (作成時) と PATCH (config更新時) の両方から
 * 呼ぶ共通ロジック (ADR-0013で関数抽出)。不正なら ApiError を throw する。
 */
function validateSourceConfig(type: SourceRow['type'], config: SourceConfigInput | undefined): void {
  if (config) {
    if (type === 'sitemap' || type === 'sitemap-index') {
      const badKeys = findConfigNotApplicableKeys(config, SITEMAP_ONLY_CONFIG_KEYS);
      if (badKeys.length > 0) {
        throw badRequest(
          'config_not_applicable',
          `config key(s) not applicable to ${type} sources: ${badKeys.join(', ')}`,
        );
      }
    } else if (type === 'page') {
      const badKeys = findConfigNotApplicableKeys(config, PAGE_ONLY_CONFIG_KEYS);
      if (badKeys.length > 0) {
        throw badRequest(
          'config_not_applicable',
          `config key(s) not applicable to page sources: ${badKeys.join(', ')}`,
        );
      }
    } else {
      // rss/atom は config を一切受け付けない (従来どおり)。
      throw badRequest('config_not_applicable', `config is not applicable to ${type} sources`);
    }
  }

  if (type === 'page' && config?.page_mode === 'extract' && !config.extract?.item_selector) {
    throw badRequest('invalid_selector', 'extract.item_selector is required when page_mode is "extract"');
  }
  // item/link/title の3セレクタとも lol-html でパース可能かを検証する。不正な
  // link_selector/title_selector を通すと、抽出実行時 (extractItems の HTMLRewriter.on) に
  // throw して毎チェック失敗し続けるため、ここで弾く (レビュー指摘)。
  if (config?.extract) {
    const selectorFields = [
      ['item_selector', config.extract.item_selector],
      ['link_selector', config.extract.link_selector],
      ['title_selector', config.extract.title_selector],
    ] as const;
    for (const [field, selector] of selectorFields) {
      if (selector !== undefined && !isValidRewriterSelector(selector)) {
        throw badRequest('invalid_selector', `extract.${field} is not a valid selector: ${selector}`);
      }
    }

    // ADR-0013: extract.fields の各要素は selector/label のどちらか一方のみ必須。
    for (const f of config.extract.fields ?? []) {
      const hasSelector = f.selector !== undefined;
      const hasLabel = f.label !== undefined;
      if (hasSelector === hasLabel) {
        throw badRequest(
          'invalid_field',
          `extract.fields[].selector と label はどちらか一方のみ指定してください (name=${f.name})`,
        );
      }
      if (f.selector !== undefined && !isValidRewriterSelector(f.selector)) {
        throw badRequest(
          'invalid_selector',
          `extract.fields[].selector is not a valid selector: ${f.selector} (name=${f.name})`,
        );
      }
    }
  }
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

    validateSourceConfig(body.type, body.config);

    const source = await createSource(c.env.DB, {
      siteId: body.site_id,
      type: body.type,
      url: body.url,
      config: toSourceConfig(body.config),
    });
    return c.json(serializeSource(source), 201);
  });

  // ADR-0013: 既存 Source の config だけを更新する。url/type/site_id は変更不可
  // (site.rename と同じ「単一フィールドPATCH + 監査イベント」の形に揃える)。
  router.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const source = await getSource(c.env.DB, id);
    if (!source) throw notFound('source_not_found', 'source not found');

    const body = parseWith(updateSourceConfigSchema, await readJsonBody(c));
    validateSourceConfig(source.type, body.config);

    const config = toSourceConfig(body.config) ?? null;
    const updated = await updateSourceConfig(c.env.DB, id, config);
    if (!updated) throw notFound('source_not_found', 'source not found');

    await recordAuditEvent(c.env.DB, {
      actor: 'admin',
      action: 'source.update_config',
      subject: id,
      payload: { before: source.config, after: config },
    });

    return c.json(serializeSource(updated));
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
