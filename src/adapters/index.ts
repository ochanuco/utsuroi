import type { AdapterParseResult } from '../shared/contracts';
import type { SourceType } from '../shared/types';
import { parseAtom } from './atom';
import { AdapterParseError } from './errors';
import { parseRss } from './rss';
import { buildSitemapIndexResult, buildSitemapResult } from './sitemap';
import { parseXmlDocument } from './xml';

export { AdapterParseError } from './errors';
export type { AdapterParseErrorCode } from './errors';
export { detectFeedType } from './detect';
export { parseRss } from './rss';
export { parseAtom } from './atom';
export { parseSitemap, parseSitemapIndex } from './sitemap';

/**
 * Source種別に応じて Feed/Sitemap のバイト列をパースする中心的なエントリポイント。
 *
 * - rss / atom: それぞれ専用パーサへ委譲する (ルート要素が一致しない場合は throw)。
 * - sitemap / sitemap-index: 実際のルート要素 (urlset / sitemapindex) を見て
 *   自動判別する。sourceType='sitemap' で sitemapindex が来た場合、および
 *   その逆 (sourceType='sitemap-index' で urlset が来た場合) のどちらも
 *   実体に応じた kind を返す (対称に自動判別する方が呼び出し側にとって
 *   驚きが少ないための解釈。仕様が明示するのは前者方向のみ)。
 * - page 等、Feed/Sitemap 形式でない SourceType は本アダプタの対象外として
 *   AdapterParseError('unsupported_source_type') を throw する。
 */
export function parseSource(
  sourceType: SourceType,
  body: Uint8Array,
  opts: { baseUrl: string; headerCharset?: string },
): AdapterParseResult {
  switch (sourceType) {
    case 'rss':
      return parseRss(body, opts);
    case 'atom':
      return parseAtom(body, opts);
    case 'sitemap':
    case 'sitemap-index': {
      const doc = parseXmlDocument(body, opts.headerCharset);
      const sitemapindex = doc.sitemapindex;
      if (sitemapindex && typeof sitemapindex === 'object') {
        return buildSitemapIndexResult(sitemapindex as Record<string, unknown>, opts);
      }
      const urlset = doc.urlset;
      if (urlset && typeof urlset === 'object') {
        return buildSitemapResult(urlset as Record<string, unknown>, opts);
      }
      throw new AdapterParseError(
        'unexpected_root',
        'sitemap: expected <urlset> or <sitemapindex> root element',
      );
    }
    default:
      throw new AdapterParseError(
        'unsupported_source_type',
        `parseSource: unsupported sourceType "${sourceType}"`,
      );
  }
}
