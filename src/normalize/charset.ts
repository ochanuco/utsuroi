/**
 * 生バイト列を UTF-8 統一の文字列にベストエフォートで復号する。
 *
 * 優先順位 (WHATWG のエンコーディング決定アルゴリズム準拠):
 * 1. BOM (UTF-8 / UTF-16LE / UTF-16BE) があればそれに従って復号する。
 * 2. HTTP レスポンスの Content-Type ヘッダの charset パラメータ (headerCharset 引数)。
 * 3. 先頭付近のバイトを ISO-8859-1 として復号し (ASCII範囲は主要な文字コードで同一のため
 *    charset 宣言の検出に安全に使える)、`<meta charset=...>` /
 *    `<meta http-equiv="Content-Type" content="...charset=...">` / XML宣言の
 *    `encoding="..."` を正規表現で探す (meta/XML宣言スニッフ)。
 * 4. 上記いずれにも該当しない、またはサポート外の label の場合は UTF-8 (fatal: false) にフォールバックする。
 *
 * headerCharset が TextDecoder でサポートされない label の場合は、その優先順位を飛ばして
 * 3.のスニッフへフォールバックする (呼び出し元が不正な Content-Type を渡してきても壊れないため)。
 */
export function decodeHtmlBestEffort(raw: Uint8Array, headerCharset?: string): string {
  const bom = detectBom(raw);
  if (bom) {
    return new TextDecoder(bom.encoding).decode(raw.subarray(bom.length));
  }

  const normalizedHeaderCharset = headerCharset?.trim();
  if (normalizedHeaderCharset) {
    if (isUtf8Label(normalizedHeaderCharset)) {
      return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(raw);
    }
    try {
      return new TextDecoder(normalizedHeaderCharset, { fatal: false, ignoreBOM: false }).decode(raw);
    } catch {
      // TextDecoder 非対応の label。meta/XML宣言スニッフへフォールバックする。
    }
  }

  const sniffLength = Math.min(raw.length, 4096);
  const asciiPreview = new TextDecoder('iso-8859-1').decode(raw.subarray(0, sniffLength));
  const label = sniffCharsetLabel(asciiPreview);

  if (label && !isUtf8Label(label)) {
    try {
      const decoder = new TextDecoder(label, { fatal: false, ignoreBOM: false });
      return decoder.decode(raw);
    } catch {
      // サポート外の label。UTF-8 にフォールバック。
    }
  }

  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(raw);
}

/**
 * HTTP の `Content-Type` ヘッダ値から charset パラメータを抽出する (例:
 * 'text/html; charset=Shift_JIS' -> 'Shift_JIS')。無ければ undefined。
 */
export function extractCharsetFromContentType(contentType: string | null | undefined): string | undefined {
  if (!contentType) return undefined;
  const match = contentType.match(/charset\s*=\s*("?)([^;"\s]+)\1/i);
  const value = match?.[2]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function isUtf8Label(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized === 'utf-8' || normalized === 'utf8';
}

function detectBom(raw: Uint8Array): { encoding: string; length: number } | null {
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    return { encoding: 'utf-8', length: 3 };
  }
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return { encoding: 'utf-16le', length: 2 };
  }
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    return { encoding: 'utf-16be', length: 2 };
  }
  return null;
}

// (?<![\w-]) の negative lookbehind は、属性名の直前が英数字/アンダースコア/ハイフンでは
// ないこと (= 属性名の先頭であること) を要求する。これが無いと `data-charset="x"` の
// ような複合属性名の一部 (`charset`) を誤って属性名そのものとしてマッチしてしまう
// (`\b` だけでは `-` と英字の間にも語境界が成立してしまうため防げない)。
const META_CHARSET_RE = /<meta[^>]+(?<![\w-])charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i;
const META_TAG_RE = /<meta\b[^>]*>/gi;
const HTTP_EQUIV_ATTR_RE = /(?<![\w-])http-equiv\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const CONTENT_ATTR_RE = /(?<![\w-])content\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const CONTENT_CHARSET_RE = /charset\s*=\s*([a-zA-Z0-9_-]+)/i;
const XML_DECL_RE = /<\?xml[^>]+encoding\s*=\s*["']([a-zA-Z0-9_-]+)["']/i;

/**
 * `<meta http-equiv="Content-Type" content="...charset=...">` の charset を、
 * http-equiv / content の属性順序に依存せず抽出する。
 */
function sniffMetaHttpEquivCharset(preview: string): string | null {
  const metaTags = preview.match(META_TAG_RE);
  if (!metaTags) return null;

  for (const tag of metaTags) {
    const httpEquivMatch = tag.match(HTTP_EQUIV_ATTR_RE);
    if (!httpEquivMatch) continue;
    const httpEquivValue = httpEquivMatch[1] ?? httpEquivMatch[2] ?? httpEquivMatch[3];
    if (httpEquivValue?.toLowerCase() !== 'content-type') continue;

    const contentMatch = tag.match(CONTENT_ATTR_RE);
    if (!contentMatch) continue;
    const contentValue = contentMatch[1] ?? contentMatch[2] ?? contentMatch[3];
    if (!contentValue) continue;

    const charsetMatch = contentValue.match(CONTENT_CHARSET_RE);
    if (charsetMatch?.[1]) return charsetMatch[1];
  }

  return null;
}

function sniffCharsetLabel(preview: string): string | null {
  const metaCharset = preview.match(META_CHARSET_RE);
  if (metaCharset?.[1]) return metaCharset[1];

  const metaHttpEquiv = sniffMetaHttpEquivCharset(preview);
  if (metaHttpEquiv) return metaHttpEquiv;

  const xmlDecl = preview.match(XML_DECL_RE);
  if (xmlDecl?.[1]) return xmlDecl[1];

  return null;
}
