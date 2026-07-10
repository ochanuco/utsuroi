/**
 * href/src 属性値を baseUrl 基準の絶対URLに解決し、tracking query パラメータを除去する。
 *
 * ベストエフォート方針:
 * - `javascript:` / `data:` / `mailto:` / `tel:` など http(s) 以外のスキームは
 *   URL解決の対象外とし、値をそのまま返す (絶対URL化・tracking除去の対象外)。
 * - `URL` コンストラクタで解決できない値 (空文字・不正な相対パス等) はそのまま返す。
 * - フラグメントのみの値 (`#foo`) も baseUrl 基準で絶対化する (一貫性のため)。
 * - HTMLRewriter から渡ってくる属性値は HTML実体参照 (`&amp;` 等) が未デコードのまま
 *   渡されるため (例: `href="a?x=1&amp;y=2"` は生の `&amp;` を含む文字列として届く)、
 *   URL解析の前に代表的な実体参照をデコードする。
 */
export function normalizeUrlAttribute(
  value: string,
  baseUrl: string,
  stripQueryParams: readonly string[],
): string {
  const trimmed = decodeCommonHtmlEntities(value.trim());
  if (trimmed === '') return value;

  let resolved: URL;
  try {
    resolved = new URL(trimmed, baseUrl);
  } catch {
    return value;
  }

  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    // http(s) 以外 (javascript:, data:, mailto:, tel: 等) は書き換えない。
    return value;
  }

  stripTrackingParams(resolved.searchParams, stripQueryParams);

  return resolved.toString();
}

function stripTrackingParams(params: URLSearchParams, patterns: readonly string[]): void {
  const keysToDelete: string[] = [];
  for (const key of params.keys()) {
    if (matchesAnyPattern(key, patterns)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    params.delete(key);
  }
}

/**
 * href/src 属性値中の代表的な HTML実体参照をデコードする (ベストエフォート)。
 * 名前付き参照は URL に現れうる範囲 (&amp; &lt; &gt; &quot; &#39;/&apos;) のみを対象とし、
 * 数値参照 (10進 `&#NN;` / 16進 `&#xHH;`) にも対応する。
 */
function decodeCommonHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ref: string) => {
    if (ref[0] === '#') {
      const isHex = ref[1] === 'x' || ref[1] === 'X';
      const codePoint = Number.parseInt(isHex ? ref.slice(2) : ref.slice(1), isHex ? 16 : 10);
      const isValidCodePoint = Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff;
      return isValidCodePoint ? String.fromCodePoint(codePoint) : match;
    }
    switch (ref.toLowerCase()) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return match;
    }
  });
}

function matchesAnyPattern(key: string, patterns: readonly string[]): boolean {
  const lowerKey = key.toLowerCase();
  return patterns.some((pattern) => {
    const lowerPattern = pattern.toLowerCase();
    if (lowerPattern.endsWith('*')) {
      return lowerKey.startsWith(lowerPattern.slice(0, -1));
    }
    return lowerKey === lowerPattern;
  });
}
