/**
 * normalizedHtml 用の空白・改行正規化。
 * - 連続する空白文字 (改行・タブ含む) を半角スペース1つに圧縮する。
 * - タグ間 (`>` と `<` の間) の空白 (プリティプリント由来のインデント等) を除去する。
 * - 先頭・末尾の空白をトリムする。
 *
 * 既知の制約: `>` の直後に空白、その後に `<` が続くパターンを属性値の内部と区別しない
 * 簡易実装のため、属性値の中にたまたま `>   <` のような並びが含まれるケース (極めて稀) は
 * タグ間トリムの対象になり得る。ベストエフォートとして許容する。
 */
export function collapseHtmlWhitespace(html: string): string {
  const collapsed = html.replace(/[ \t\r\n\f]+/g, ' ');
  const trimmedBetweenTags = collapsed.replace(/>\s+</g, '><');
  return trimmedBetweenTags.trim();
}

/**
 * extractedText 用の正規化。
 * ブロック境界に BLOCK_BREAK_SENTINEL (実際の本文には現れない私用領域文字) を挿入した
 * テキスト断片配列を受け取り、
 * - まず本文中の実際の空白・改行 (センチネルは対象外) を1つのスペースに圧縮
 * - その上で BLOCK_BREAK_SENTINEL を行区切りとみなして分割
 * - 各行を trim し、空行を除去
 * したプレーンテキストを返す。
 * 本文中に元から含まれる改行はブロック境界とはみなさず単なる空白として扱う点がポイント
 * (ブロック境界かどうかはセンチネルの有無だけで判定する)。
 */
export function normalizeExtractedText(parts: readonly string[], sentinel: string): string {
  const joined = parts.join('');
  const collapsed = joined.replace(/[ \t\r\n\f]+/g, ' ');
  const lines = collapsed
    .split(sentinel)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.join('\n');
}
