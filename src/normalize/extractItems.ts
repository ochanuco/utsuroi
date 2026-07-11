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

/** extract.fields (ADR-0013) の1フィールド定義。selector / label はどちらか一方を指定する */
export interface ExtractFieldOptions {
  /** 通知に表示するフィールド名 */
  name: string;
  /** セレクタ方式: アイテム内の最初のマッチのサブツリーテキストを値とする */
  selector?: string;
  /** ラベル方式: dt のサブツリーテキスト (正規化後) がこのラベルと完全一致する直後の dd を値とする */
  label?: string;
}

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
  /**
   * 構造化フィールド抽出の設定 (ADR-0013)。設定順で ExtractedItem.fields に反映される。
   * selector/label がどちらも有効な値か (どちらか一方必須・件数上限) は API 層
   * (src/api/routes/sources.ts) が作成時に検証済みという前提で、ここでは追加検証しない。
   */
  fields?: ExtractFieldOptions[];
}

/** ADR-0013: extractItems が返す1アイテム。fields は設定順、未マッチのフィールドは含まない */
export interface ExtractedItem extends FeedItem {
  fields: Array<{ name: string; value: string }>;
}

/** タイトル文字列の上限 (SPEC 準拠, 他 Source 種別と揃える) */
const TITLE_MAX_LENGTH = 256;

/** フィールド値の上限 (ADR-0013) */
const FIELD_VALUE_MAX_LENGTH = 200;

/** extract.fields の1フィールドについて、アイテム内での抽出進行状態を追跡する */
interface FieldState {
  /** 最初のマッチが確定済みか (確定後は後続のマッチを無視する) */
  matched: boolean;
  /** 現在、このフィールドの値になるサブツリーのテキストを収集中か */
  collecting: boolean;
  value: string;
}

interface ItemAccumulator {
  url: string | null;
  title: string;
  /**
   * 「url を提供したリンク要素」の子孫テキストを今まさに収集中かどうか。
   * titleSelector 未指定時のみ使う (指定時はリンクテキストへフォールバックしない)。
   */
  collectingLinkTitle: boolean;
  /** opts.fields と同じ並び順のフィールド抽出状態 (ADR-0013) */
  fields: FieldState[];
  /** ラベル方式 (dt/dd) 用: 現在開いている dt のサブツリーテキストを収集中か */
  dtCollecting: boolean;
  /** ラベル方式用: 現在開いている dt のサブツリーテキストのバッファ */
  dtBuffer: string;
  /**
   * ラベル方式用: 直前に閉じた dt の正規化済みラベル文字列。次の dt が開いた時点で
   * リセットされる (ADR-0013: 「直前ラベル」は次の dt 開始でリセット)。
   * 正規化後に空文字になる dt (`<dt>&nbsp;</dt>` 等のダミー行) は null のままにする。
   */
  lastLabel: string | null;
  /** ラベル方式用: 現在開いている dd が対応する fields のインデックス (無ければ null) */
  ddTargetFieldIndex: number | null;
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

/**
 * フィールド (ラベル/値) 用のテキスト正規化 (ADR-0013)。collapseWhitespace に加え、
 * `&nbsp;` (10進/16進の数値文字参照表記を含む) を半角スペース相当として扱う。
 * HTMLRewriter の text ハンドラは実体参照をデコードせずそのまま渡す (lol-html 実測) ため、
 * `<dt>&nbsp;</dt>` のようなダミー行を素の collapseWhitespace だけでは空文字と判定できない。
 */
function normalizeFieldText(input: string): string {
  const withoutNbsp = input.replace(/&nbsp;|&#160;|&#xa0;/gi, ' ');
  return collapseWhitespace(withoutNbsp);
}

export async function extractItems(body: Uint8Array, opts: ExtractItemsOptions): Promise<ExtractedItem[]> {
  const html = decodeHtmlBestEffort(body, opts.headerCharset);

  const linkSelector = opts.linkSelector ?? 'a';
  const combinedLinkSelector = `${opts.itemSelector} ${linkSelector}`;
  const combinedTitleSelector = opts.titleSelector ? `${opts.itemSelector} ${opts.titleSelector}` : null;
  const fieldOptions = opts.fields ?? [];

  const accumulators: ItemAccumulator[] = [];
  let current: ItemAccumulator | null = null;
  let depth = 0;

  const rewriter = new HTMLRewriter().on(opts.itemSelector, {
    element(e) {
      depth += 1;
      if (depth === 1) {
        // 深さ 0→1: 新しいアイテムの開始 (入れ子の内側マッチは無視し、外側優先でフラット化する)。
        current = {
          url: null,
          title: '',
          collectingLinkTitle: false,
          fields: fieldOptions.map(() => ({ matched: false, collecting: false, value: '' })),
          dtCollecting: false,
          dtBuffer: '',
          lastLabel: null,
          ddTargetFieldIndex: null,
        };
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

  // --- extract.fields (ADR-0013) -------------------------------------------------------
  //
  // セレクタ方式: `${itemSelector} ${field.selector}` の最初のマッチのサブツリーテキストを
  // 値とする。link/titleSelector と同じ element+onEndTag による境界確定 + 「最初のマッチ優先」
  // (FieldState.matched) の組み合わせで実現する。
  fieldOptions.forEach((f, idx) => {
    if (!f.selector) return;
    const combinedFieldSelector = `${opts.itemSelector} ${f.selector}`;
    rewriter.on(combinedFieldSelector, {
      element(e) {
        if (!current) return;
        const fs = current.fields[idx];
        if (!fs || fs.matched) return;
        fs.collecting = true;
        e.onEndTag(() => {
          fs.matched = true;
          fs.collecting = false;
        });
      },
      text(t) {
        const fs = current?.fields[idx];
        if (fs?.collecting) fs.value += t.text;
      },
    });
  });

  // ラベル方式: dt のサブツリーテキストを正規化した結果が label と完全一致する直後の dd を値とする。
  // dt/dd はアイテムごとに1つのハンドラで共通処理し (フィールド数分ハンドラを増やさない)、
  // dt 終了時に確定した lastLabel を dd 開始時に fields (label方式のみ、未確定のもの優先) と照合する。
  if (fieldOptions.some((f) => f.label)) {
    rewriter.on(`${opts.itemSelector} dt`, {
      element(e) {
        if (!current) return;
        const acc = current;
        acc.dtBuffer = '';
        acc.dtCollecting = true;
        // 「直前ラベル」は次の dt が開いた時点でリセットする (ADR-0013)。
        acc.lastLabel = null;
        e.onEndTag(() => {
          acc.dtCollecting = false;
          const normalized = normalizeFieldText(acc.dtBuffer);
          // 正規化後に空文字になる dt (`<dt>&nbsp;</dt>` 等のダミー行) はラベル扱いしない。
          acc.lastLabel = normalized.length > 0 ? normalized : null;
        });
      },
      text(t) {
        if (current?.dtCollecting) current.dtBuffer += t.text;
      },
    });

    rewriter.on(`${opts.itemSelector} dd`, {
      element(e) {
        if (!current) return;
        const acc = current;
        acc.ddTargetFieldIndex = null;
        if (acc.lastLabel !== null) {
          // 未確定 (matched===false) の label方式フィールドのうち、最初に一致したものを採用する。
          const idx = fieldOptions.findIndex((f, i) => f.label === acc.lastLabel && !acc.fields[i]!.matched);
          if (idx !== -1) {
            acc.ddTargetFieldIndex = idx;
            acc.fields[idx]!.collecting = true;
          }
        }
        e.onEndTag(() => {
          const idx = acc.ddTargetFieldIndex;
          if (idx !== null) {
            acc.fields[idx]!.matched = true;
            acc.fields[idx]!.collecting = false;
          }
          acc.ddTargetFieldIndex = null;
        });
      },
      text(t) {
        if (!current || current.ddTargetFieldIndex === null) return;
        current.fields[current.ddTargetFieldIndex]!.value += t.text;
      },
    });
  }

  const rewritten = rewriter.transform(new Response(html));
  await rewritten.text();

  const items: ExtractedItem[] = [];
  // 同一URL (正規化後に一致するものを含む) へ解決される複数アイテムは最初の1件だけを採用する。
  // stableKey = url のため重複を通すと同一 dedupeKey の FeedItem が並び、下流で無駄な
  // upsert/照会が走るだけになる (buildSitemapResult の seen と同じ規約)。
  const seen = new Set<string>();
  for (const acc of accumulators) {
    if (!acc.url) continue; // URL の無いアイテムは除外する (エラーにはしない)
    if (seen.has(acc.url)) continue;
    seen.add(acc.url);
    const title = collapseWhitespace(acc.title);
    const fields: Array<{ name: string; value: string }> = [];
    fieldOptions.forEach((f, idx) => {
      const fs = acc.fields[idx];
      if (!fs?.matched) return; // 未マッチのフィールドは結果から省く (ADR-0013)
      const value = normalizeFieldText(fs.value);
      fields.push({ name: f.name, value: value.slice(0, FIELD_VALUE_MAX_LENGTH) });
    });
    items.push({
      stableKey: acc.url,
      url: acc.url,
      title: title.length > 0 ? title.slice(0, TITLE_MAX_LENGTH) : null,
      publishedAt: null,
      updatedAt: null,
      summary: null,
      fields,
    });
  }
  return items;
}
