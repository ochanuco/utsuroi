/**
 * describePipeline (ADR-0016 パイプライン可視化、バックエンド側 PR-A) の単体テスト。
 * resolveContentProcessor と同じ RECIPES テーブルから引くため、DB や fetch のスタブは不要
 * (SourceRow のオブジェクトリテラルのみで完結する)。
 */
import { describe, expect, it } from 'vitest';
import { describePipeline, resolveContentProcessor } from '../../src/pipeline/contentProcessor';
import type { SourceRow } from '../../src/db';

function fakeSource(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 'source-1',
    siteId: 'site-1',
    type: 'page',
    url: 'https://example.com/',
    config: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function stageIds(source: SourceRow): string[] {
  return describePipeline(source).map((s) => s.id);
}

describe('describePipeline', () => {
  it('page + pageMode=extract -> fetch/extract/diff/notify', () => {
    expect(stageIds(fakeSource({ type: 'page', config: { pageMode: 'extract', extract: { itemSelector: '.item' } } })))
      .toEqual(['fetch', 'extract', 'diff', 'notify']);
  });

  it('page + pageMode未指定 -> fetch/content-diff/notify', () => {
    expect(stageIds(fakeSource({ type: 'page', config: null }))).toEqual(['fetch', 'content-diff', 'notify']);
  });

  it("page + pageMode='content' -> fetch/content-diff/notify", () => {
    expect(stageIds(fakeSource({ type: 'page', config: { pageMode: 'content' } }))).toEqual([
      'fetch',
      'content-diff',
      'notify',
    ]);
  });

  it('sitemap + sitemapMode=traverse -> traverse/diff/notify', () => {
    expect(stageIds(fakeSource({ type: 'sitemap', config: { sitemapMode: 'traverse' } }))).toEqual([
      'traverse',
      'diff',
      'notify',
    ]);
  });

  it('sitemap + sitemapMode未指定 -> fetch/sitemap-diff/notify', () => {
    expect(stageIds(fakeSource({ type: 'sitemap', config: null }))).toEqual(['fetch', 'sitemap-diff', 'notify']);
  });

  it("sitemap-index + sitemapMode='direct' -> fetch/sitemap-diff/notify", () => {
    expect(
      stageIds(fakeSource({ type: 'sitemap-index', config: { sitemapMode: 'direct' } })),
    ).toEqual(['fetch', 'sitemap-diff', 'notify']);
  });

  it('rss -> fetch/extract/diff/notify', () => {
    expect(stageIds(fakeSource({ type: 'rss', config: null }))).toEqual(['fetch', 'extract', 'diff', 'notify']);
  });

  it('atom -> fetch/extract/diff/notify', () => {
    expect(stageIds(fakeSource({ type: 'atom', config: null }))).toEqual(['fetch', 'extract', 'diff', 'notify']);
  });

  it('resolveContentProcessor と describePipeline が同じレシピキーを引く (RECIPES テーブル整合の回帰防止)', () => {
    // page:extract と page:content は RECIPES 上の別エントリ (processor も stages も異なる)。
    // 同じレシピキーに解決される2つの source (id/url違い) は同一 processor 参照・同一 stages を返し、
    // 別キーに解決される source とは異なる processor 参照・異なる stages を返すはずである。
    const extractA = fakeSource({
      id: 'a',
      type: 'page',
      config: { pageMode: 'extract', extract: { itemSelector: '.item' } },
    });
    const extractB = fakeSource({
      id: 'b',
      url: 'https://example.com/other',
      type: 'page',
      config: { pageMode: 'extract', extract: { itemSelector: '.other' } },
    });
    const contentSource = fakeSource({ id: 'c', type: 'page', config: null });

    // 同じレシピキー (page:extract) -> 同一 processor 参照・同一 stages
    expect(resolveContentProcessor(extractA)).toBe(resolveContentProcessor(extractB));
    expect(stageIds(extractA)).toEqual(stageIds(extractB));

    // 別レシピキー (page:content) -> 異なる processor 参照・異なる stages
    expect(resolveContentProcessor(extractA)).not.toBe(resolveContentProcessor(contentSource));
    expect(stageIds(extractA)).not.toEqual(stageIds(contentSource));
  });
});
