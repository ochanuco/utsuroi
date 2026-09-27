/**
 * Classify段 (ADR-0019): Source config の classify に基づく決定論的タグ付けを検証する。
 * - computeTags: DB非依存の純粋な照合ロジック
 * - classifyDetectedChanges / processFeedItems 経由: DetectedChange への実際の反映・永続化
 */
import { describe, expect, it, vi } from 'vitest';
import { computeTags, classifyDetectedChanges } from '../../src/pipeline/classify';
import { processFeedItems } from '../../src/pipeline/feed';
import type { DetectedChange } from '../../src/pipeline/notify';
import type { CheckContext } from '../../src/pipeline/types';
import type { Env } from '../../src/shared/env';
import type { FeedItem } from '../../src/shared/contracts';
import type { MonitorRow, SiteRow, SourceConfig, SourceRow } from '../../src/db';
import { getChange, insertChangeIfNew, listChangesByMonitor, setChangeTagsIfNull } from '../../src/db';
import { buildPipelineFixture, db, fakeEnv } from './helpers';

type ClassifyConfig = NonNullable<SourceConfig['classify']>;

describe('computeTags: pure matcher', () => {
  it('matches the title field', () => {
    const config: ClassifyConfig = {
      rules: [{ tag: 'area:north', match: { field: 'title', pattern: '北町|北台' } }],
    };
    expect(computeTags(config, { title: '北町の新着物件', url: null, summary: null })).toEqual(['area:north']);
    expect(computeTags(config, { title: '他のエリアの物件', url: null, summary: null })).toEqual([]);
  });

  it('matches the url field', () => {
    const config: ClassifyConfig = {
      rules: [{ tag: 'site:suumo', match: { field: 'url', pattern: '^https://suumo\\.jp/' } }],
    };
    expect(
      computeTags(config, { title: null, url: 'https://suumo.jp/chintai/1', summary: null }),
    ).toEqual(['site:suumo']);
    expect(
      computeTags(config, { title: null, url: 'https://example.com/1', summary: null }),
    ).toEqual([]);
  });

  it('matches the summary field', () => {
    const config: ClassifyConfig = {
      rules: [{ tag: 'price:high', match: { field: 'summary', pattern: '[5-9],\\d{3}万円' } }],
    };
    expect(computeTags(config, { title: null, url: null, summary: '価格: 5,800万円' })).toEqual(['price:high']);
    expect(computeTags(config, { title: null, url: null, summary: '価格: 2,800万円' })).toEqual([]);
  });

  it('matches an extracted field by name (ADR-0013 extract.fields)', () => {
    const config: ClassifyConfig = {
      rules: [{ tag: 'area:north', match: { field: '所在地', pattern: '北町|北台' } }],
    };
    const input = { title: null, url: null, summary: null, fields: [{ name: '所在地', value: '〇〇県〇〇市北町' }] };
    expect(computeTags(config, input)).toEqual(['area:north']);
  });

  it('treats a missing field as no match (does not throw)', () => {
    const config: ClassifyConfig = {
      rules: [{ tag: 'area:north', match: { field: '所在地', pattern: '北町' } }],
    };
    expect(computeTags(config, { title: null, url: null, summary: null })).toEqual([]);
  });

  it('honors the "i" flag for case-insensitive matching', () => {
    const config: ClassifyConfig = {
      rules: [{ tag: 'lang:en', match: { field: 'title', pattern: 'hello', flags: 'i' } }],
    };
    expect(computeTags(config, { title: 'HELLO WORLD', url: null, summary: null })).toEqual(['lang:en']);
  });

  it('applies multiple rules and dedupes tags, preserving rule order', () => {
    const config: ClassifyConfig = {
      rules: [
        { tag: 'area:north', match: { field: 'title', pattern: '北町' } },
        { tag: 'topic:sale', match: { field: 'title', pattern: '売却' } },
        // 同じ tag を別ルールから再度付与しても1回だけ (dedupe)
        { tag: 'area:north', match: { field: 'summary', pattern: '市内' } },
      ],
    };
    const input = { title: '北町の売却物件', url: null, summary: '市内' };
    expect(computeTags(config, input)).toEqual(['area:north', 'topic:sale']);
  });

  it('falls back to default_tag when no rule matches', () => {
    const config: ClassifyConfig = {
      rules: [{ tag: 'area:north', match: { field: 'title', pattern: '北町' } }],
      defaultTag: 'area:other',
    };
    expect(computeTags(config, { title: '無関係のタイトル', url: null, summary: null })).toEqual(['area:other']);
  });

  it('truncates the field value to 2000 chars before matching', () => {
    // パターンが末尾の "END" にのみマッチするようにし、2000文字を超える手前に置いた場合は
    // マッチせず (切り詰められて見えなくなる)、2000文字以内に置いた場合はマッチすることを確認する。
    const config: ClassifyConfig = {
      rules: [{ tag: 'has-end-marker', match: { field: 'summary', pattern: 'END$' } }],
    };
    const beyondLimit = `${'x'.repeat(2010)}END`;
    const withinLimit = `${'x'.repeat(1990)}END`;
    expect(computeTags(config, { title: null, url: null, summary: beyondLimit })).toEqual([]);
    expect(computeTags(config, { title: null, url: null, summary: withinLimit })).toEqual(['has-end-marker']);
  });

  it('returns an empty array when no rule matches and no default_tag is set', () => {
    const config: ClassifyConfig = {
      rules: [{ tag: 'area:north', match: { field: 'title', pattern: '北町' } }],
    };
    expect(computeTags(config, { title: '無関係のタイトル', url: null, summary: null })).toEqual([]);
  });
});

describe('classifyDetectedChanges: unit-level (DetectedChange 直接操作)', () => {
  function buildCtx(monitor: MonitorRow, source: SourceRow, site: SiteRow): CheckContext {
    return {
      env: fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      db: db(),
      monitor,
      source,
      site,
      policy: {} as unknown as CheckContext['policy'],
      job: {} as unknown as CheckContext['job'],
      now: () => Date.now(),
      changeIds: [],
    };
  }

  async function makeDetected(monitorId: string, item: FeedItem): Promise<DetectedChange> {
    const result = await insertChangeIfNew(db(), {
      monitorId,
      targetUrl: item.url ?? 'https://example.com/x',
      kind: 'new',
      dedupeKey: `dedupe-${Math.random()}`,
      title: item.title,
    });
    return { row: result.row, inserted: true, item };
  }

  it('does nothing when config.classify is unset (tags stay NULL)', async () => {
    const { monitor, source, site } = await buildPipelineFixture({ sourceType: 'rss' });
    const detected = await makeDetected(monitor.id, {
      stableKey: 'a',
      url: 'https://example.com/a',
      title: '北町の物件',
      publishedAt: null,
      updatedAt: null,
      summary: null,
    });

    await classifyDetectedChanges(buildCtx(monitor, source, site), [detected]);

    expect(detected.row.tags).toBeNull();
    expect((await getChange(db(), detected.row.id))?.tags).toBeNull();
  });

  it('prefers the (possibly enriched) row.title over item.title for the title field', async () => {
    const classify: ClassifyConfig = {
      rules: [{ tag: 'area:north', match: { field: 'title', pattern: '北町' } }],
    };
    const { monitor, source, site } = await buildPipelineFixture({
      sourceType: 'rss',
      sourceConfig: { classify },
    });
    const detected = await makeDetected(monitor.id, {
      stableKey: 'b',
      url: 'https://example.com/b',
      title: '無関係のタイトル',
      publishedAt: null,
      updatedAt: null,
      summary: null,
    });
    // enrichTitle 段が row.title を書き換えた状態を模す。
    detected.row.title = '北町の物件（enrich後）';

    await classifyDetectedChanges(buildCtx(monitor, source, site), [detected]);

    expect(detected.row.tags).toEqual(['area:north']);
  });

  it('does not reclassify a Change whose tags are already set (retry keeps the original routing)', async () => {
    const classify: ClassifyConfig = {
      rules: [{ tag: 'area:north', match: { field: 'title', pattern: '北町' } }],
    };
    const { monitor, source, site } = await buildPipelineFixture({
      sourceType: 'rss',
      sourceConfig: { classify },
    });
    const detected = await makeDetected(monitor.id, {
      stableKey: 'c',
      url: 'https://example.com/c',
      title: '北町の物件', // ルールに一致する内容だが、既に別のタグで分類済みとする
      publishedAt: null,
      updatedAt: null,
      summary: null,
    });
    await setChangeTagsIfNull(db(), detected.row.id, ['area:already-classified']);
    detected.row.tags = ['area:already-classified'];

    await classifyDetectedChanges(buildCtx(monitor, source, site), [detected]);

    expect(detected.row.tags).toEqual(['area:already-classified']);
    expect((await getChange(db(), detected.row.id))?.tags).toEqual(['area:already-classified']);
  });

  it('does not throw when a rule pattern fails to compile (fail-open, skips only that rule)', async () => {
    const classify = {
      rules: [
        // API層のバリデーションを経由しない直接テストなので、不正なパターンを注入できる。
        { tag: 'broken', match: { field: 'title', pattern: '(' } },
        { tag: 'area:north', match: { field: 'title', pattern: '北町' } },
      ],
    } as unknown as ClassifyConfig;
    const { monitor, source, site } = await buildPipelineFixture({
      sourceType: 'rss',
      sourceConfig: { classify },
    });
    const detected = await makeDetected(monitor.id, {
      stableKey: 'd',
      url: 'https://example.com/d',
      title: '北町の物件',
      publishedAt: null,
      updatedAt: null,
      summary: null,
    });

    await expect(classifyDetectedChanges(buildCtx(monitor, source, site), [detected])).resolves.toBeUndefined();
    expect(detected.row.tags).toEqual(['area:north']);
  });
});

describe('processFeedItems: Classify段の統合 (ADR-0019)', () => {
  function buildCtx(monitor: MonitorRow, source: SourceRow, site: SiteRow): CheckContext {
    return {
      env: fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'] }),
      db: db(),
      monitor,
      source,
      site,
      policy: {} as unknown as CheckContext['policy'],
      job: {} as unknown as CheckContext['job'],
      now: () => Date.now(),
      changeIds: [],
    };
  }

  it('stores tags on a newly-detected Change when the source has a classify config', async () => {
    const classify: ClassifyConfig = {
      rules: [{ tag: 'area:north', match: { field: 'title', pattern: '北町' } }],
      defaultTag: 'area:other',
    };
    const { monitor, source, site } = await buildPipelineFixture({
      sourceType: 'rss',
      sourceUrl: 'https://example.com/classify-new',
      sourceConfig: { classify },
    });

    // baseline (lastCheckedAt===null) を抜けた状態を模す (feed.test.ts と同じ手法)。
    const nonBaselineMonitor = { ...monitor, lastCheckedAt: '2020-01-01T00:00:00.000Z' };
    const item: FeedItem = {
      stableKey: 'https://example.com/classify-new/1',
      url: 'https://example.com/classify-new/1',
      title: '北町の新着物件',
      publishedAt: null,
      updatedAt: null,
      summary: null,
    };
    await processFeedItems(buildCtx(nonBaselineMonitor, source, site), [item]);

    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('new');
    expect(changes[0]?.tags).toEqual(['area:north']);
  });

  it('leaves tags NULL when the source has no classify config', async () => {
    const { monitor, source, site } = await buildPipelineFixture({
      sourceType: 'rss',
      sourceUrl: 'https://example.com/no-classify',
    });

    const nonBaselineMonitor = { ...monitor, lastCheckedAt: '2020-01-01T00:00:00.000Z' };
    const item: FeedItem = {
      stableKey: 'https://example.com/no-classify/1',
      url: 'https://example.com/no-classify/1',
      title: '北町の新着物件',
      publishedAt: null,
      updatedAt: null,
      summary: null,
    };
    await processFeedItems(buildCtx(nonBaselineMonitor, source, site), [item]);

    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.tags).toBeNull();
  });

  it('does not reclassify a pre-existing Change recovered via dedupeKey conflict (inserted:false, tags already set)', async () => {
    const classify: ClassifyConfig = {
      rules: [{ tag: 'area:north', match: { field: 'title', pattern: '北町' } }],
    };
    const { monitor, source, site } = await buildPipelineFixture({
      sourceType: 'rss',
      sourceUrl: 'https://example.com/classify-retry-tagged',
      sourceConfig: { classify },
    });
    const nonBaselineMonitor = { ...monitor, lastCheckedAt: '2020-01-01T00:00:00.000Z' };

    const item: FeedItem = {
      stableKey: 'retry-key-tagged',
      url: 'https://example.com/classify-retry-tagged/1',
      title: '北町の新着物件', // classify config と一致する内容だが、既に別タグで分類済みとする
      publishedAt: null,
      updatedAt: null,
      summary: null,
    };
    // クラッシュ後の再試行を模す: 実URLの Target が未登録のまま、Change だけが
    // 既に (別タグで) 分類済みの状態で存在する。
    const preExisting = await insertChangeIfNew(db(), {
      monitorId: monitor.id,
      targetUrl: item.url!,
      kind: 'new',
      dedupeKey: item.stableKey,
      title: item.title,
    });
    await setChangeTagsIfNull(db(), preExisting.row.id, ['area:pre-existing']);

    await processFeedItems(buildCtx(nonBaselineMonitor, source, site), [item]);

    const persisted = await getChange(db(), preExisting.row.id);
    expect(persisted?.tags).toEqual(['area:pre-existing']);
    // 重複挿入は起きない (dedupeKey UNIQUE 制約により1行のまま)。
    expect(await listChangesByMonitor(db(), monitor.id)).toHaveLength(1);
  });

  it('classifies a pre-existing Change recovered via dedupeKey conflict when its tags are still NULL', async () => {
    const classify: ClassifyConfig = {
      rules: [{ tag: 'area:north', match: { field: 'title', pattern: '北町' } }],
    };
    const { monitor, source, site } = await buildPipelineFixture({
      sourceType: 'rss',
      sourceUrl: 'https://example.com/classify-retry-untagged',
      sourceConfig: { classify },
    });
    const nonBaselineMonitor = { ...monitor, lastCheckedAt: '2020-01-01T00:00:00.000Z' };

    const item: FeedItem = {
      stableKey: 'retry-key-untagged',
      url: 'https://example.com/classify-retry-untagged/1',
      title: '北町の新着物件',
      publishedAt: null,
      updatedAt: null,
      summary: null,
    };
    // Change だけが未分類 (tags NULL) のまま既に存在する状態を模す。
    const preExisting = await insertChangeIfNew(db(), {
      monitorId: monitor.id,
      targetUrl: item.url!,
      kind: 'new',
      dedupeKey: item.stableKey,
      title: item.title,
    });
    expect(preExisting.row.tags).toBeNull();

    await processFeedItems(buildCtx(nonBaselineMonitor, source, site), [item]);

    const persisted = await getChange(db(), preExisting.row.id);
    expect(persisted?.tags).toEqual(['area:north']);
    expect(await listChangesByMonitor(db(), monitor.id)).toHaveLength(1);
  });
});
