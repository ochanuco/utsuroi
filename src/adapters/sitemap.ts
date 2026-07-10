import type { AdapterParseResult, FeedItem } from '../shared/contracts';
import { normalizeIsoDate } from './dates';
import { AdapterParseError } from './errors';
import { resolveUrl } from './keys';
import { asArray, parseXmlDocument, textOf } from './xml';

/** すでにパース済みの <urlset> ノードから AdapterParseResult を組み立てる */
export function buildSitemapResult(
  urlset: Record<string, unknown>,
  opts: { baseUrl: string },
): AdapterParseResult {
  const items: FeedItem[] = [];
  const seen = new Set<string>();

  for (const raw of asArray(urlset.url)) {
    if (!raw || typeof raw !== 'object') continue;
    const urlNode = raw as Record<string, unknown>;
    const locText = textOf(urlNode.loc);
    if (!locText) continue;

    const loc = resolveUrl(locText, opts.baseUrl);
    if (seen.has(loc)) continue;
    seen.add(loc);

    const lastmodRaw = textOf(urlNode.lastmod);

    items.push({
      stableKey: loc,
      url: loc,
      title: null,
      publishedAt: null,
      updatedAt: lastmodRaw ? normalizeIsoDate(lastmodRaw) : null,
      summary: null,
    });
  }

  return { kind: 'sitemap', items, childSitemaps: [], meta: { title: null } };
}

/** すでにパース済みの <sitemapindex> ノードから AdapterParseResult を組み立てる */
export function buildSitemapIndexResult(
  sitemapindex: Record<string, unknown>,
  opts: { baseUrl: string },
): AdapterParseResult {
  const childSitemaps: string[] = [];
  const seen = new Set<string>();

  for (const raw of asArray(sitemapindex.sitemap)) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as Record<string, unknown>;
    const locText = textOf(node.loc);
    if (!locText) continue;
    const loc = resolveUrl(locText, opts.baseUrl);
    if (seen.has(loc)) continue;
    seen.add(loc);
    childSitemaps.push(loc);
  }

  return { kind: 'sitemap-index', items: [], childSitemaps, meta: { title: null } };
}

/** Sitemap (urlset) をパースする。ルート要素が異なる場合は throw する */
export function parseSitemap(body: Uint8Array, opts: { baseUrl: string }): AdapterParseResult {
  const doc = parseXmlDocument(body);
  const urlset = doc.urlset;
  if (!urlset || typeof urlset !== 'object') {
    throw new AdapterParseError('unexpected_root', 'sitemap: expected <urlset> root element');
  }
  return buildSitemapResult(urlset as Record<string, unknown>, opts);
}

/** Sitemap Index (sitemapindex) をパースする。ルート要素が異なる場合は throw する */
export function parseSitemapIndex(
  body: Uint8Array,
  opts: { baseUrl: string },
): AdapterParseResult {
  const doc = parseXmlDocument(body);
  const sitemapindex = doc.sitemapindex;
  if (!sitemapindex || typeof sitemapindex !== 'object') {
    throw new AdapterParseError('unexpected_root', 'sitemap-index: expected <sitemapindex> root element');
  }
  return buildSitemapIndexResult(sitemapindex as Record<string, unknown>, opts);
}
