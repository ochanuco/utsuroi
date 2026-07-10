import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { AdapterParseError } from './errors';

/**
 * 常に配列として扱うタグ名。
 * - item / entry / url / sitemap: 単一件でも配列正規化するため
 * - link: RSS(単一 <link>テキスト) と Atom(rel毎に複数の <link href=.../>) の
 *   両方を同じ形で扱えるようにするため
 */
const ARRAY_TAGS = new Set(['item', 'entry', 'url', 'sitemap', 'link']);

/**
 * バイト列先頭の BOM から UTF-16 LE/BE を検出する。BOM が無ければ null (UTF-8/ASCII系とみなす)。
 * UTF-16 は XML宣言の encoding= をUTF-8前提でスニッフすると文字化けし誤判定するため、
 * BOM 検出を encoding宣言スニッフより先に行う必要がある。
 */
function detectUtf16Bom(body: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return 'utf-16le';
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return 'utf-16be';
  return null;
}

/**
 * XML宣言の encoding を best-effort で読み取り、TextDecoder でデコードする。
 * 宣言が無い/デコーダが対応しない場合は UTF-8 にフォールバックする。
 *
 * 優先順位 (WHATWG のエンコーディング決定アルゴリズム準拠): UTF-16 BOM > HTTPヘッダ charset
 * (headerCharset 引数) > XML宣言の encoding= スニッフ > UTF-8。
 *
 * UTF-16 LE/BE の BOM がある場合は、他のいずれよりも先にそれを検出し、対応する TextDecoder で
 * 直接デコードする (BOM 無しの場合のみ、headerCharset → XML宣言スニッフの順で判定する)。
 */
function decodeBody(body: Uint8Array, headerCharset?: string): string {
  const utf16Bom = detectUtf16Bom(body);
  if (utf16Bom) {
    try {
      return new TextDecoder(utf16Bom, { fatal: false, ignoreBOM: false }).decode(body);
    } catch {
      // デコーダが対応しない環境では UTF-8 フォールバックへ (通常ここには来ない想定)。
    }
  }

  const normalizedHeaderCharset = headerCharset?.trim().toLowerCase();
  if (normalizedHeaderCharset && normalizedHeaderCharset !== 'utf-8' && normalizedHeaderCharset !== 'utf8') {
    try {
      return new TextDecoder(normalizedHeaderCharset, { fatal: false, ignoreBOM: false }).decode(body);
    } catch {
      // TextDecoder 非対応の label。XML宣言スニッフへフォールバックする。
    }
  } else if (normalizedHeaderCharset) {
    // ヘッダが明示的に utf-8 を宣言している場合はそれを信頼し、XML宣言スニッフを介さず直接デコードする。
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(body);
  }

  let encoding = 'utf-8';
  try {
    const sniffLen = Math.min(200, body.length);
    const head = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(
      body.subarray(0, sniffLen)
    );
    const match = head.match(/<\?xml[^>]*\sencoding=["']([^"']+)["']/i);
    if (match?.[1]) {
      encoding = match[1].trim().toLowerCase();
    }
  } catch {
    encoding = 'utf-8';
  }
  try {
    return new TextDecoder(encoding, { fatal: false, ignoreBOM: false }).decode(body);
  } catch {
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(body);
  }
}

/**
 * バイト列を decode + XML妥当性検証 + パースし、プレーンオブジェクトへ変換する。
 * 不正なXMLは throw せず AdapterParseError('invalid_xml') を投げる。
 *
 * headerCharset: HTTP レスポンスの Content-Type ヘッダから抽出した charset。
 * 指定時は XML宣言の encoding= スニッフより優先される (decodeBody 参照)。
 */
export function parseXmlDocument(body: Uint8Array, headerCharset?: string): Record<string, unknown> {
  const xml = decodeBody(body, headerCharset);

  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: true });
  if (validation !== true) {
    const msg = validation.err?.msg ?? 'unknown validation error';
    throw new AdapterParseError('invalid_xml', `XML parse error: ${msg}`);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: true,
    isArray: (tagName: string) => ARRAY_TAGS.has(tagName),
  });

  try {
    const result = parser.parse(xml);
    if (!result || typeof result !== 'object') {
      throw new AdapterParseError('invalid_xml', 'XML parse error: empty document');
    }
    return result as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AdapterParseError) throw err;
    throw new AdapterParseError('invalid_xml', `XML parse error: ${(err as Error).message}`);
  }
}

/** 値を配列へ正規化する (undefined は空配列) */
export function asArray<T = unknown>(node: unknown): T[] {
  if (node == null) return [];
  return Array.isArray(node) ? (node as T[]) : [node as T];
}

/**
 * タグの値からテキストを取り出す。
 * fast-xml-parser は CDATA を通常テキストへマージするため、
 * 文字列 or { '#text': string, ...attrs } のいずれかを想定すればよい。
 */
export function textOf(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === 'string') {
    const trimmed = node.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  if (typeof node === 'object') {
    const text = (node as Record<string, unknown>)['#text'];
    if (typeof text === 'string') {
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof text === 'number' || typeof text === 'boolean') {
      return String(text);
    }
  }
  return null;
}

/** 属性値 (parseAttributeValue: false のため常に string | undefined) を取得する */
export function attrOf(node: unknown, name: string): string | null {
  if (node == null || typeof node !== 'object') return null;
  const value = (node as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}
