import type { AdapterParseResult, FeedItem } from '../shared/contracts';
import { normalizeRfc822Date } from './dates';
import { AdapterParseError } from './errors';
import { titleDateHashKey } from './keys';
import { asArray, parseXmlDocument, textOf } from './xml';

/** RSS 2.0 <channel><item> をパースする */
export function parseRss(body: Uint8Array, opts: { baseUrl: string; headerCharset?: string }): AdapterParseResult {
  const doc = parseXmlDocument(body, opts.headerCharset);
  const rss = doc.rss;
  if (!rss || typeof rss !== 'object') {
    throw new AdapterParseError('unexpected_root', 'rss: expected <rss> root element');
  }
  const channel = (rss as Record<string, unknown>).channel;
  if (!channel || typeof channel !== 'object') {
    throw new AdapterParseError('unexpected_root', 'rss: missing <channel> element');
  }
  const channelNode = channel as Record<string, unknown>;
  const title = textOf(channelNode.title);

  const items: FeedItem[] = [];
  const seen = new Set<string>();

  for (const raw of asArray(channelNode.item)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;

    const itemTitle = textOf(item.title);
    const linkNodes = asArray(item.link);
    const link = linkNodes.length > 0 ? textOf(linkNodes[0]) : null;
    const pubDateRaw = textOf(item.pubDate);
    const publishedAt = pubDateRaw ? normalizeRfc822Date(pubDateRaw) : null;
    const guid = textOf(item.guid);

    // stableKey 優先順: guid > link > title+pubDate ハッシュ
    const stableKey = guid ?? link ?? titleDateHashKey(itemTitle, pubDateRaw);

    if (seen.has(stableKey)) continue;
    seen.add(stableKey);

    items.push({
      stableKey,
      url: link,
      title: itemTitle,
      publishedAt,
      updatedAt: null,
      summary: textOf(item.description),
    });
  }

  return { kind: 'rss', items, childSitemaps: [], meta: { title } };
}
