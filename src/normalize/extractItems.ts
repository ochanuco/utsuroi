/**
 * page Source の「新着検知」モード (ADR-0011, ROADMAP Phase 2 Processor の最初の具体化) 用、
 * CSSセレクタによるアイテム集合抽出。
 *
 * HTMLRewriter (workerd 組み込み、lol-html ベース) のセレクタ対応範囲は normalize.ts:16-24 と
 * 同じ保証範囲 (タグ名 / #id / .class / 属性セレクタ / 空白区切りの子孫結合子 程度) に限定する。
 * itemSelector / linkSelector / titleSelector にはこの範囲のセレクタを渡すことを前提とする。
 *
 * 抽出方式の設計判断 (スパイクで確認した lol-html の実挙動に基づく):
 * - `.on(itemSelector, { element })` + `element.onEndTag()` で各アイテムの開始/終了境界を
 *   取得できる。この開始/終了イベントはストリーミング処理の中で文書順に発火する。
 * - `.on(`${itemSelector} ${linkSelector}`, ...)` のような子孫結合子セレクタのハンドラも、
 *   同じ文書順ストリームの中で item の開始/終了イベントと正しく交互に発火する。そのため、
 *   「現在開いているアイテム」を指す1個のクロージャ変数 (current) を、item の開始/終了
 *   ハンドラと子孫セレクタのハンドラの両方から参照・更新するだけで、子孫要素がどのアイテムに
 *   属するかを追加のマーカー処理なしに相関できる (実測: test/normalize/extractItems.test.ts の
 *   「スパイクで固定した挙動」テスト群を参照)。
 * - text ハンドラは、マッチした要素そのものだけでなくその子孫のテキストノードも受け取る
 *   (normalize.ts の extractText と同じ lol-html の挙動)。
 * - 入れ子アイテム (item 要素の内側にさらに item 要素がある場合): lol-html はネストした
 *   両方の要素に対して独立に element/onEndTag を発火する (自動でのフラット化はしない)。
 *   本実装は itemSelector マッチの深さカウンタを持ち、深さが 0→1 になった発火のみを
 *   「新しいアイテムの開始」とみなし (内側の再帰的マッチは無視する)、深さが 1→0 に
 *   戻った発火でそのアイテムを確定する。これにより「外側優先でフラット化する」仕様
 *   (内側の item は独立したアイテムを作らず、外側アイテムの内容に取り込まれる) を実現する。
 *   子孫セレクタ (linkSelector/titleSelector) のマッチは、深さに関わらず常に「現在開いている
 *   外側アイテム」に紐付けられる。
 *
 * この設計により、include.ts のようなセンチネルコメント挿入方式へのフォールバックは不要と
 * 判断した (element 境界 + 子孫セレクタの相関がスパイクで問題なく成立したため)。
 *
 * URL の無いアイテム (有効な http(s) href を持つリンクが1つも見つからない) は結果から除外する。
 * stableKey は url そのもの (v1 は sitemap の lastmod のような更新検知手段を持たないため、
 * 'new' のみを検知対象とする。ADR-0011 参照)。
 */
import type { FeedItem } from '../shared/contracts';
import { decodeHtmlBestEffort } from './charset';
import { normalizeUrlAttribute } from './url';
import { DEFAULT_STRIP_QUERY_PARAMS } from './constants';

export interface ExtractItemsOptions {
  /** アイテム集合を区切る CSS セレクタ (例: '.property_unit') */
  itemSelector: string;
  /** アイテム内でリンクを探す CSS セレクタ (既定 'a') */
  linkSelector?: string;
  /** アイテム内でタイトルを探す CSS セレクタ (省略時はリンクテキストにフォールバック) */
  titleSelector?: string;
  /** 相対URL解決の基準 (通常は Source URL) */
  baseUrl: string;
  /** HTTP レスポンスの Content-Type ヘッダから抽出した charset (normalize.ts と同じ decode 経路) */
  headerCharset?: string;
}

/** タイトル文字列の上限 (SPEC 準拠, 他 Source 種別と揃える) */
const TITLE_MAX_LENGTH = 256;

interface ItemAccumulator {
  url: string | null;
  title: string;
  /**
   * 「url を提供したリンク要素」の子孫テキストを今まさに収集中かどうか。
   * titleSelector 未指定時のみ使う (指定時はリンクテキストへフォールバックしない)。
   */
  collectingLinkTitle: boolean;
}

/**
 * href 属性値を絶対URL化し、http(s) の有効な URL としてパースできる場合のみ文字列を返す。
 * tracking クエリパラメータの除去は既存の normalize (src/normalize/url.ts) の
 * normalizeUrlAttribute を再利用する (href の HTML実体参照デコードも含めて一貫させるため)。
 * v1 では stripQueryParams の Source別カスタマイズは行わず既定リストを使う。
 */
function resolveItemLinkUrl(href: string, baseUrl: string): string | null {
  const resolved = normalizeUrlAttribute(href, baseUrl, DEFAULT_STRIP_QUERY_PARAMS);
  try {
    const u = new URL(resolved);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** 連続する空白 (改行・タブ含む) を1つの半角スペースに畳み、前後をトリムする */
function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

export async function extractItems(body: Uint8Array, opts: ExtractItemsOptions): Promise<FeedItem[]> {
  const html = decodeHtmlBestEffort(body, opts.headerCharset);

  const linkSelector = opts.linkSelector ?? 'a';
  const combinedLinkSelector = `${opts.itemSelector} ${linkSelector}`;
  const combinedTitleSelector = opts.titleSelector ? `${opts.itemSelector} ${opts.titleSelector}` : null;

  const accumulators: ItemAccumulator[] = [];
  let current: ItemAccumulator | null = null;
  let depth = 0;

  const rewriter = new HTMLRewriter().on(opts.itemSelector, {
    element(e) {
      depth += 1;
      if (depth === 1) {
        // 深さ 0→1: 新しいアイテムの開始 (入れ子の内側マッチは無視し、外側優先でフラット化する)。
        current = { url: null, title: '', collectingLinkTitle: false };
        accumulators.push(current);
      }
      e.onEndTag(() => {
        depth = Math.max(0, depth - 1);
        if (depth === 0) {
          current = null;
        }
      });
    },
  });

  rewriter.on(combinedLinkSelector, {
    element(e) {
      if (!current) return;
      if (current.url !== null) {
        // 既に url を確定済み (=最初に見つかった有効なリンク) より後のリンクは無視する。
        current.collectingLinkTitle = false;
        return;
      }
      const href = e.getAttribute('href');
      if (href === null) {
        current.collectingLinkTitle = false;
        return;
      }
      const resolved = resolveItemLinkUrl(href, opts.baseUrl);
      if (resolved === null) {
        // href はあるが http(s) の有効な絶対URLに解決できない (mailto: 等) -> このリンクは
        // 採用せず、後続のリンクを引き続き探す。
        current.collectingLinkTitle = false;
        return;
      }
      current.url = resolved;
      // titleSelector 未指定時のみ、url を提供したこのリンクの子孫テキストをタイトルとして集める。
      current.collectingLinkTitle = !opts.titleSelector;
    },
    text(t) {
      if (current?.collectingLinkTitle) {
        current.title += t.text;
      }
    },
  });

  if (combinedTitleSelector) {
    rewriter.on(combinedTitleSelector, {
      text(t) {
        if (current) {
          current.title += t.text;
        }
      },
    });
  }

  const rewritten = rewriter.transform(new Response(html));
  await rewritten.text();

  const items: FeedItem[] = [];
  for (const acc of accumulators) {
    if (!acc.url) continue; // URL の無いアイテムは除外する (エラーにはしない)
    const title = collapseWhitespace(acc.title);
    items.push({
      stableKey: acc.url,
      url: acc.url,
      title: title.length > 0 ? title.slice(0, TITLE_MAX_LENGTH) : null,
      publishedAt: null,
      updatedAt: null,
      summary: null,
    });
  }
  return items;
}
