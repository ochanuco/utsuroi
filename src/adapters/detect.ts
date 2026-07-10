import { parseXmlDocument } from './xml';

/**
 * ルート要素からフィード種別を判定する (`<rss>` / `<feed>`)。
 * 不正なXML・どちらでもないルート要素の場合は throw せず null を返す
 * (呼び出し側が SourceType を決定するための判定用途であり、
 * 解析失敗そのものは parseSource/parseRss/parseAtom の責務とするため)。
 */
export function detectFeedType(body: Uint8Array): 'rss' | 'atom' | null {
  let doc: Record<string, unknown>;
  try {
    doc = parseXmlDocument(body);
  } catch {
    return null;
  }
  if (doc.rss && typeof doc.rss === 'object') return 'rss';
  if (doc.feed && typeof doc.feed === 'object') return 'atom';
  return null;
}
