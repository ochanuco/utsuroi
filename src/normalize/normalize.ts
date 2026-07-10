import type { NormalizeOptions, NormalizedContent } from '../shared/contracts';
import { sha256Hex } from '../shared/hash';
import {
  BLOCK_BREAK_SENTINEL,
  BLOCK_TAGS,
  DEFAULT_STRIP_QUERY_PARAMS,
  INCLUDE_END_MARKER,
  INCLUDE_START_MARKER,
  NORMALIZATION_VERSION,
  URL_ATTRIBUTE_NAMES,
} from './constants';
import { decodeHtmlBestEffort } from './charset';
import { isDynamicAttribute, sortAttributeNames } from './attributes';
import { normalizeUrlAttribute } from './url';
import { extractIncludedRegions } from './include';
import { collapseHtmlWhitespace, normalizeExtractedText } from './text';

/**
 * HTMLRewriter (workerd 組み込み、lol-html ベース) のセレクタ対応範囲について:
 * `.on(selector, handlers)` に渡すセレクタ文字列はそのまま lol-html のセレクタエンジンに
 * 渡している。本実装が動作確認・想定している範囲はタグ名 (`div`)、`#id`、`.class`、
 * 属性セレクタ `[attr]`、および空白区切りの子孫結合子 (`div p`) 程度の簡易セレクタであり、
 * ignoreSelectors / includeSelectors にはこの範囲のセレクタを渡すことを前提とする。
 * より高度なセレクタ (擬似クラス、隣接兄弟結合子等) は lol-html が対応していれば動作する
 * 可能性があるが、本実装ではテスト・保証の対象外。
 */

const BLOCK_TAGS_SELECTOR = BLOCK_TAGS.join(', ');

/**
 * HTMLバイト列を SPEC §12 の初期正規化ルールに従って NormalizedContent へ変換する。
 *
 * 処理順:
 * 1. UTF-8統一 (meta charset / XML宣言のベストエフォート復号)
 * 2. HTMLRewriter で script/style/noscript/コメント除去、ignoreSelectors除去、
 *    includeSelectors マーキング、href/src の絶対URL化+tracking除去、
 *    動的属性除外、属性順序の正規化 (アルファベット順に再構築)
 * 3. includeSelectors 指定時はマーキングされた区間のみを抽出
 * 4. 空白・改行の正規化 (normalizedHtml)
 * 5. ブロック要素境界に改行を挿入した上でのプレーンテキスト抽出 (extractedText)
 * 6. 各段階のハッシュ計算 (rawHash / normalizedHash / textHash)
 */
export async function normalizeHtml(
  raw: Uint8Array,
  opts: NormalizeOptions,
): Promise<NormalizedContent> {
  const rawHash = await sha256Hex(raw);

  const decoded = decodeHtmlBestEffort(raw);
  const stage1Html = await runCleanPass(decoded, opts);

  const includedHtml =
    opts.includeSelectors && opts.includeSelectors.length > 0
      ? extractIncludedRegions(stage1Html)
      : stage1Html;

  const normalizedHtml = collapseHtmlWhitespace(includedHtml);
  const extractedText = await extractText(includedHtml);

  const [normalizedHash, textHash] = await Promise.all([
    sha256Hex(normalizedHtml),
    sha256Hex(extractedText),
  ]);

  return {
    normalizedHtml,
    extractedText,
    rawHash,
    normalizedHash,
    textHash,
    normalizationVersion: NORMALIZATION_VERSION,
  };
}

/**
 * script/style/noscript/コメント除去、ignore/include セレクタ処理、
 * href/src 絶対URL化+tracking除去、動的属性除外、属性順序正規化を単一の
 * HTMLRewriter パスで実行する。
 */
async function runCleanPass(html: string, opts: NormalizeOptions): Promise<string> {
  const stripScripts = opts.stripScripts ?? true;
  const stripStyles = opts.stripStyles ?? true;
  const stripComments = opts.stripComments ?? true;
  const stripQueryParams = opts.stripQueryParams ?? DEFAULT_STRIP_QUERY_PARAMS;
  const dynamicAttributesOverride = opts.dynamicAttributes;

  const rewriter = new HTMLRewriter();

  if (stripScripts) {
    rewriter.on('script', {
      element: (e) => {
        e.remove();
      },
    });
    // noscript は script 系のフォールバックマークアップとみなし stripScripts に束ねる
    // (NormalizeOptions に個別フラグが存在しないための判断)。
    rewriter.on('noscript', {
      element: (e) => {
        e.remove();
      },
    });
  }
  if (stripStyles) {
    rewriter.on('style', {
      element: (e) => {
        e.remove();
      },
    });
  }
  if (stripComments) {
    rewriter.onDocument({
      comments: (c) => {
        c.remove();
      },
    });
  }

  for (const selector of opts.ignoreSelectors ?? []) {
    rewriter.on(selector, {
      element: (e) => {
        e.remove();
      },
    });
  }

  for (const selector of opts.includeSelectors ?? []) {
    rewriter.on(selector, {
      element: (e) => {
        e.before(INCLUDE_START_MARKER, { html: true });
        e.after(INCLUDE_END_MARKER, { html: true });
      },
    });
  }

  // 全要素対象: href/src の絶対URL化+tracking除去、動的属性除外、属性順序正規化。
  rewriter.on('*', {
    element: (e) => {
      // e.attributes は単一のイテレータのため、必ず一度だけ配列化してから使う。
      const attrs = [...e.attributes].map((pair) => ({ name: pair[0] ?? '', value: pair[1] ?? '' }));
      for (const { name } of attrs) {
        e.removeAttribute(name);
      }
      const rebuilt: Array<{ name: string; value: string }> = [];
      for (const { name, value } of attrs) {
        if (isDynamicAttribute(name, dynamicAttributesOverride)) {
          continue;
        }
        if (URL_ATTRIBUTE_NAMES.includes(name.toLowerCase())) {
          rebuilt.push({ name, value: normalizeUrlAttribute(value, opts.baseUrl, stripQueryParams) });
        } else {
          rebuilt.push({ name, value });
        }
      }
      for (const name of sortAttributeNames(rebuilt.map((a) => a.name))) {
        const found = rebuilt.find((a) => a.name === name);
        if (found) e.setAttribute(name, found.value);
      }
    },
  });

  const rewritten = rewriter.transform(new Response(html));
  return await rewritten.text();
}

/**
 * ブロック要素境界に改行を挿入しつつプレーンテキストを抽出する。
 * HTMLRewriter の Text ノードはデコード済みテキスト (実体参照が解決済み) を返すため、
 * ここで得られる文字列はエンティティデコード不要。
 */
async function extractText(html: string): Promise<string> {
  const parts: string[] = [];

  const rewriter = new HTMLRewriter()
    .on(BLOCK_TAGS_SELECTOR, {
      element: (e) => {
        parts.push(BLOCK_BREAK_SENTINEL);
        e.onEndTag(() => {
          parts.push(BLOCK_BREAK_SENTINEL);
        });
      },
    })
    .onDocument({
      text: (t) => {
        parts.push(t.text);
      },
    });

  const rewritten = rewriter.transform(new Response(html));
  await rewritten.text();

  return normalizeExtractedText(parts, BLOCK_BREAK_SENTINEL);
}
