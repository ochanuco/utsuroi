import type { AdapterParseResult, FeedItem } from '../shared/contracts';
import { normalizeIsoDate } from './dates';
import { AdapterParseError } from './errors';
import { titleDateHashKey } from './keys';
import { asArray, parseXmlDocument, textOf } from './xml';

function linkHref(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === 'object') {
    const href = (node as Record<string, unknown>)['@_href'];
    if (typeof href === 'string') {
      const trimmed = href.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    // href属性が無い場合はテキストノード (仕様上は稀だが best-effort で拾う)
    return textOf(node);
  }
  return textOf(node);
}

function linkRel(node: unknown): string | null {
  if (node == null || typeof node !== 'object') return null;
  const rel = (node as Record<string, unknown>)['@_rel'];
  return typeof rel === 'string' ? rel : null;
}

/** entry の <link> 群から stableKey/url に使う「alternate」リンクを選ぶ */
function pickAlternateLink(links: unknown[]): string | null {
  let fallback: string | null = null;
  for (const link of links) {
    const href = linkHref(link);
    if (!href) continue;
    const rel = linkRel(link);
    // rel 省略時は alternate とみなす (Atom仕様)
    if (rel === 'alternate' || rel === null) return href;
    if (fallback === null) fallback = href;
  }
  return fallback;
}

/** Atom <feed><entry> をパースする */
export function parseAtom(body: Uint8Array, _opts: { baseUrl: string }): AdapterParseResult {
  const doc = parseXmlDocument(body);
  const feed = doc.feed;
  if (!feed || typeof feed !== 'object') {
    throw new AdapterParseError('unexpected_root', 'atom: expected <feed> root element');
  }
  const feedNode = feed as Record<string, unknown>;
  const title = textOf(feedNode.title);

  const items: FeedItem[] = [];
  const seen = new Set<string>();

  for (const raw of asArray(feedNode.entry)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;

    const entryTitle = textOf(entry.title);
    const links = asArray(entry.link);
    const altLink = pickAlternateLink(links);
    const id = textOf(entry.id);

    // stableKey 優先順: id > link[rel=alternate] > link
    const stableKey =
      id ?? altLink ?? (links.length > 0 ? linkHref(links[0]) : null) ?? titleDateHashKey(entryTitle, textOf(entry.updated));

    if (seen.has(stableKey)) continue;
    seen.add(stableKey);

    const updatedRaw = textOf(entry.updated);
    const publishedRaw = textOf(entry.published);

    items.push({
      stableKey,
      url: altLink ?? (links.length > 0 ? linkHref(links[0]) : null),
      title: entryTitle,
      publishedAt: publishedRaw ? normalizeIsoDate(publishedRaw) : null,
      updatedAt: updatedRaw ? normalizeIsoDate(updatedRaw) : null,
      summary: textOf(entry.summary) ?? textOf(entry.content),
    });
  }

  return { kind: 'atom', items, childSitemaps: [], meta: { title } };
}
