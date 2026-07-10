/**
 * 正規化ロジックの版。正規化アルゴリズムに影響する変更を行った場合はインクリメントする。
 * NormalizedContent.normalizationVersion に格納される。
 */
export const NORMALIZATION_VERSION = 1;

/**
 * tracking query パラメータの既定除去リスト。
 * 末尾が `*` の要素は前方一致 (例: `utm_*` は `utm_source` 等にマッチ) として扱う。
 * 大文字小文字は無視して比較する。
 */
export const DEFAULT_STRIP_QUERY_PARAMS: readonly string[] = [
  'utm_*',
  'gclid',
  'fbclid',
  'yclid',
  'mc_cid',
  'mc_eid',
];

/**
 * opts.dynamicAttributes 省略時に完全一致で除外する属性名 (小文字比較)。
 */
export const DEFAULT_DYNAMIC_ATTRIBUTES: readonly string[] = ['nonce', 'data-nonce'];

/**
 * opts.dynamicAttributes 省略時のみ追加で適用するパターンマッチ。
 * csrf系・timestamp系の属性名 (data-csrf-token, x-timestamp 等) を広く拾うためのベストエフォート。
 * opts.dynamicAttributes を明示指定した場合はこのパターンは使わず、完全一致のみで判定する。
 */
export const DEFAULT_DYNAMIC_ATTRIBUTE_PATTERNS: readonly RegExp[] = [/csrf/i, /timestamp/i];

/**
 * href/src の絶対URL化・属性正規化を行う対象属性名。
 */
export const URL_ATTRIBUTE_NAMES: readonly string[] = ['href', 'src'];

/**
 * extractedText 抽出時に前後に改行境界を挿入するブロック要素タグ。
 * HTML5 の代表的なブロックレベル/セクショニング要素を対象とする (網羅的ではない)。
 */
export const BLOCK_TAGS: readonly string[] = [
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tr',
  'ul',
];

/** includeSelectors マーキング用の内部センチネル (最終出力には残らない) */
export const INCLUDE_START_MARKER = '<!--utsuroi:include-start-->';
export const INCLUDE_END_MARKER = '<!--utsuroi:include-end-->';

/**
 * extractedText 抽出時、ブロック境界を示すために使う内部センチネル文字。
 * Unicode 私用領域 (Private Use Area) の1文字を使い、通常のHTML本文テキストとは
 * 区別できるようにする (本文中の実際の改行はいったんこのセンチネルとは別に空白として
 * 圧縮され、その後このセンチネルだけを行区切りの `\n` に変換する)。
 */
export const BLOCK_BREAK_SENTINEL = '';
