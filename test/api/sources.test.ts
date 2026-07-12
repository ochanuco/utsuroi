import { describe, expect, it } from 'vitest';
import { createSite, listAuditEventsBySubject } from '../../src/db';
import { authHeaders, buildTestApp, db, jsonHeaders, testEnv, uniqueName } from './helpers';

async function makeSite() {
  return createSite(db(), { name: uniqueName('Source Site') });
}

describe('POST /api/sources', () => {
  it('creates a source when the URL passes SSRF checks (public URL, stub resolver)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ site_id: site.id, type: 'page', url: 'https://example.com/page' }),
      },
      testEnv()
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.site_id).toBe(site.id);
    expect(body.url).toBe('https://example.com/page');
  });

  it('rejects a loopback URL literal at the static SSRF check (400)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ site_id: site.id, type: 'page', url: 'http://127.0.0.1/admin' }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('ssrf_blocked');
  });

  it('rejects a private-network URL literal (RFC1918) at the static SSRF check (400)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ site_id: site.id, type: 'rss', url: 'http://192.168.1.5/feed.xml' }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('ssrf_blocked');
  });

  it('returns 404 when site_id does not reference an existing site', async () => {
    const { app } = buildTestApp();
    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ site_id: 'nope', type: 'page', url: 'https://example.com/' }),
      },
      testEnv()
    );
    expect(res.status).toBe(404);
  });

  it('validates the source type enum (400)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();
    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ site_id: site.id, type: 'not-a-type', url: 'https://example.com/' }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
  });
});

// ADR-0010 Phase B: sitemap/sitemap-index Source の任意 config (sitemap_mode 等)。
describe('POST /api/sources: config (ADR-0010 Phase B sitemapMode)', () => {
  it('creates a sitemap-index source with a traverse config (201) and echoes it back snake_case', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'sitemap-index',
          url: 'https://example.com/sitemap-index.xml',
          config: { sitemap_mode: 'traverse', lastmod_max_age_days: 5, max_depth: 2 },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    // serializeSource は ADR-0011 で page系キーも同じ config 形状に統合したため、
    // 適用されないキー (page系) は常に null で埋められる (null passthrough)。
    expect(body.config).toEqual({
      sitemap_mode: 'traverse',
      lastmod_max_age_days: 5,
      max_depth: 2,
      child_include_patterns: null,
      page_mode: null,
      extract: null,
      ignore_selectors: null,
      include_selectors: null,
      strip_query_params: null,
    });
  });

  it('rejects config for a page-type source (400 config_not_applicable)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'page',
          url: 'https://example.com/page',
          config: { sitemap_mode: 'traverse' },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('config_not_applicable');
  });

  it('rejects an invalid sitemap_mode enum value and out-of-range lastmod_max_age_days / max_depth (400)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const invalidConfigs = [
      { sitemap_mode: 'invalid' },
      { lastmod_max_age_days: 0 },
      { lastmod_max_age_days: 31 },
      { max_depth: 0 },
      { max_depth: 6 },
    ];

    for (const config of invalidConfigs) {
      const res = await app.request(
        '/api/sources',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            site_id: site.id,
            type: 'sitemap-index',
            url: `https://example.com/invalid-config-${JSON.stringify(config)}.xml`,
            config,
          }),
        },
        testEnv()
      );
      expect(res.status, `expected 400 for config ${JSON.stringify(config)}`).toBe(400);
    }
  });
});

// ADR-0015: traverse対象の子sitemapを絞り込む child_include_patterns。
describe('POST /api/sources: config (ADR-0015 child_include_patterns)', () => {
  it('creates a sitemap-index source with child_include_patterns (201) and echoes it back', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'sitemap-index',
          url: 'https://example.com/pattern-sitemap-index.xml',
          config: { sitemap_mode: 'traverse', child_include_patterns: ['post-sitemap*.xml'] },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.config.child_include_patterns).toEqual(['post-sitemap*.xml']);
  });

  it('rejects child_include_patterns for a page-type source (400 config_not_applicable)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'page',
          url: 'https://example.com/page-with-child-include-patterns',
          config: { child_include_patterns: ['post-sitemap*.xml'] },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('config_not_applicable');
  });

  it('rejects an out-of-range patterns array (11 items, an empty string, or a 201-char string) (400)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const invalidConfigs = [
      { child_include_patterns: Array.from({ length: 11 }, (_, i) => `p${i}*.xml`) },
      { child_include_patterns: [''] },
      { child_include_patterns: ['a'.repeat(201)] },
    ];

    for (const config of invalidConfigs) {
      const res = await app.request(
        '/api/sources',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            site_id: site.id,
            type: 'sitemap-index',
            url: `https://example.com/invalid-child-patterns-${JSON.stringify(config).length}.xml`,
            config,
          }),
        },
        testEnv()
      );
      expect(res.status, `expected 400 for config ${JSON.stringify(config)}`).toBe(400);
    }
  });

  it('updates child_include_patterns via PATCH', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const created = (
      await (
        await app.request(
          '/api/sources',
          {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({
              site_id: site.id,
              type: 'sitemap',
              url: 'https://example.com/patch-child-patterns.xml',
              config: { sitemap_mode: 'traverse', child_include_patterns: ['post-sitemap*.xml'] },
            }),
          },
          testEnv()
        )
      ).json()
    ) as any;

    const res = await app.request(
      `/api/sources/${created.id}`,
      {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({
          config: { sitemap_mode: 'traverse', child_include_patterns: ['post-sitemap*.xml', 'news-sitemap*.xml'] },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.config.child_include_patterns).toEqual(['post-sitemap*.xml', 'news-sitemap*.xml']);
  });
});

// ADR-0011: page Source の「新着検知」(アイテム抽出) config。
describe('POST /api/sources: config (ADR-0011 page item extraction)', () => {
  it('creates a page source with an extract config (201) and echoes it back in serializeSource', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'page',
          url: 'https://example.com/listing',
          config: { page_mode: 'extract', extract: { item_selector: '.property_unit' } },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.config).toEqual({
      sitemap_mode: null,
      lastmod_max_age_days: null,
      max_depth: null,
      child_include_patterns: null,
      page_mode: 'extract',
      extract: { item_selector: '.property_unit', link_selector: null, title_selector: null, fields: null },
      ignore_selectors: null,
      include_selectors: null,
      strip_query_params: null,
    });
  });

  it('creates a page source with include/ignore selectors for content-diff mode (201)', async () => {
    // 本文差分モードの DOM 抽出/除外セレクタは page type に適用可能なキー
    // (PAGE_ONLY_CONFIG_KEYS)。UI から config として送っても config_not_applicable に
    // ならないことの固定 (UIレビューでの誤指摘に対する回帰テスト)。
    const { app } = buildTestApp();
    const site = await makeSite();
    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'page',
          url: 'https://example.com/article',
          config: { include_selectors: ['#main'], ignore_selectors: ['.ads', '#sidebar'] },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.config.include_selectors).toEqual(['#main']);
    expect(body.config.ignore_selectors).toEqual(['.ads', '#sidebar']);
  });

  it('rejects sitemap_mode config for a page-type source (400 config_not_applicable)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'page',
          url: 'https://example.com/page-with-sitemap-config',
          config: { sitemap_mode: 'traverse' },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('config_not_applicable');
  });

  it('rejects page_mode config for a sitemap-index-type source (400 config_not_applicable)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'sitemap-index',
          url: 'https://example.com/sitemap-index-with-page-config.xml',
          config: { page_mode: 'extract', extract: { item_selector: '.item' } },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('config_not_applicable');
  });

  it('rejects an invalid extract.item_selector (400 invalid_selector)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'page',
          url: 'https://example.com/invalid-selector',
          config: { page_mode: 'extract', extract: { item_selector: ':hover' } },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('invalid_selector');
  });

  it('rejects an invalid extract.link_selector / title_selector (400 invalid_selector)', async () => {
    // 不正な link/title セレクタを通すと抽出実行時に HTMLRewriter.on が throw して
    // 毎チェック失敗し続けるため、作成時に item_selector と同様に検証する。
    const { app } = buildTestApp();
    const site = await makeSite();
    for (const extra of [{ link_selector: ':hover' }, { title_selector: ':hover' }]) {
      const res = await app.request(
        '/api/sources',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            site_id: site.id,
            type: 'page',
            url: 'https://example.com/invalid-sub-selector',
            config: { page_mode: 'extract', extract: { item_selector: '.item', ...extra } },
          }),
        },
        testEnv()
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.code).toBe('invalid_selector');
    }
  });

  it('rejects page_mode "extract" with a missing extract.item_selector (400 invalid_selector)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'page',
          url: 'https://example.com/missing-item-selector',
          config: { page_mode: 'extract' },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('invalid_selector');
  });
});

// ADR-0013: extract.fields (構造化フィールド抽出) の検証。
describe('POST /api/sources: config (ADR-0013 extract.fields)', () => {
  it('creates a page source with selector-方式/label-方式混在の fields (201) and echoes it back', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'page',
          url: 'https://example.com/listing-fields',
          config: {
            page_mode: 'extract',
            extract: {
              item_selector: '.property_unit',
              fields: [
                { name: '価格', selector: '.dottable-value' },
                { name: '所在地', label: '所在地' },
              ],
            },
          },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.config.extract.fields).toEqual([
      { name: '価格', selector: '.dottable-value' },
      { name: '所在地', label: '所在地' },
    ]);
  });

  it('rejects a field with both selector and label (400 invalid_field)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'page',
          url: 'https://example.com/field-both',
          config: {
            page_mode: 'extract',
            extract: {
              item_selector: '.item',
              fields: [{ name: '価格', selector: '.price', label: '価格' }],
            },
          },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('invalid_field');
  });

  it('rejects a field with neither selector nor label (400 invalid_field)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'page',
          url: 'https://example.com/field-neither',
          config: {
            page_mode: 'extract',
            extract: { item_selector: '.item', fields: [{ name: '価格' }] },
          },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('invalid_field');
  });

  it('rejects an invalid field selector (400 invalid_selector)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'page',
          url: 'https://example.com/field-invalid-selector',
          config: {
            page_mode: 'extract',
            extract: { item_selector: '.item', fields: [{ name: '価格', selector: ':hover' }] },
          },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('invalid_selector');
  });

  it('rejects more than 12 fields (400)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();

    const fields = Array.from({ length: 13 }, (_, i) => ({ name: `field-${i}`, label: `label-${i}` }));
    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'page',
          url: 'https://example.com/too-many-fields',
          config: { page_mode: 'extract', extract: { item_selector: '.item', fields } },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/sources/:id (ADR-0013 config更新)', () => {
  async function makePageSource(app: ReturnType<typeof buildTestApp>['app'], site: { id: string }, url: string) {
    const res = await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          site_id: site.id,
          type: 'page',
          url,
          config: { page_mode: 'extract', extract: { item_selector: '.property_unit' } },
        }),
      },
      testEnv()
    );
    return (await res.json()) as any;
  }

  it('updates config and records an audit event (source.update_config)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();
    const created = await makePageSource(app, site, 'https://example.com/patch-target');

    const res = await app.request(
      `/api/sources/${created.id}`,
      {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({
          config: {
            page_mode: 'extract',
            extract: {
              item_selector: '.property_unit',
              fields: [{ name: '価格', selector: '.price' }],
            },
          },
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.config.extract.fields).toEqual([{ name: '価格', selector: '.price' }]);

    const events = await listAuditEventsBySubject(db(), created.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'source.update_config', actor: 'admin', subject: created.id });
  });

  it('returns 404 for an unknown source id', async () => {
    const { app } = buildTestApp();
    const res = await app.request(
      '/api/sources/nope',
      { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ config: {} }) },
      testEnv()
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe('source_not_found');
  });

  it('rejects a config key not applicable to the source type (400 config_not_applicable)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();
    const created = await makePageSource(app, site, 'https://example.com/patch-bad-key');

    const res = await app.request(
      `/api/sources/${created.id}`,
      {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ config: { sitemap_mode: 'traverse' } }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('config_not_applicable');
  });

  it('does not allow url/type/site_id to be changed via PATCH (unknown top-level keys rejected)', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();
    const created = await makePageSource(app, site, 'https://example.com/patch-immutable');

    const res = await app.request(
      `/api/sources/${created.id}`,
      {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ url: 'https://example.com/should-not-change', config: {} }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);

    const getRes = await app.request(`/api/sources/${created.id}`, { headers: authHeaders() }, testEnv());
    const getBody = (await getRes.json()) as any;
    expect(getBody.url).toBe('https://example.com/patch-immutable');
  });
});

describe('GET /api/sources', () => {
  it('lists sources by site_id', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();
    await app.request(
      '/api/sources',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ site_id: site.id, type: 'page', url: 'https://example.com/a' }),
      },
      testEnv()
    );

    const res = await app.request(`/api/sources?site_id=${site.id}`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.items).toHaveLength(1);
  });

  it('requires site_id query parameter (400)', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/sources', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/sources/:id (Site/Source/Monitor削除機能)', () => {
  it('returns 404 for an unknown source id', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/sources/nope', { method: 'DELETE', headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('source_not_found');
  });

  it('deletes a source with no monitors and records an audit event', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();
    const created = await (
      await app.request(
        '/api/sources',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ site_id: site.id, type: 'page', url: 'https://delete-source.example/' }),
        },
        testEnv()
      )
    ).json() as any;

    const deleteRes = await app.request(
      `/api/sources/${created.id}`,
      { method: 'DELETE', headers: authHeaders() },
      testEnv()
    );
    expect(deleteRes.status).toBe(200);

    const getRes = await app.request(`/api/sources/${created.id}`, { headers: authHeaders() }, testEnv());
    expect(getRes.status).toBe(404);

    const events = await listAuditEventsBySubject(db(), created.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'source.delete', actor: 'admin', subject: created.id });
  });

  it('rejects deletion with 409 source_has_monitors when a monitor still references the source', async () => {
    const { app } = buildTestApp();
    const site = await makeSite();
    const source = await (
      await app.request(
        '/api/sources',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ site_id: site.id, type: 'page', url: 'https://has-monitor.example/' }),
        },
        testEnv()
      )
    ).json() as any;
    await app.request(
      '/api/monitors',
      { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ source_id: source.id, interval_seconds: 60 }) },
      testEnv()
    );

    const res = await app.request(
      `/api/sources/${source.id}`,
      { method: 'DELETE', headers: authHeaders() },
      testEnv()
    );
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('source_has_monitors');

    // still present since deletion was rejected
    const getRes = await app.request(`/api/sources/${source.id}`, { headers: authHeaders() }, testEnv());
    expect(getRes.status).toBe(200);
  });
});
