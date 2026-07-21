/**
 * HTML から `<title>` テキストを抽出する (ADR-0016 Notify段 title enrich)。
 * normalize.ts と同じ HTMLRewriter 利用パターン (Response 経由で transform → await text())。
 */

/** タイトル文字列の上限。超過分は切り詰める */
const TITLE_MAX_CHARS = 512;

/**
 * html 内の最初の `<title>` 要素のテキストを抽出する。2つ目以降の title 要素は無視する。
 * 空白・改行は半角スペース1つに正規化し前後を trim する。空文字・title 要素なしは null。
 *
 * HTMLRewriter (workerd 組み込み) の変換はストリーム消費まで遅延される (normalize.ts /
 * extractItems.ts と同じ挙動) ため、`await rewritten.text()` で駆動し切るまでは
 * element/text ハンドラが発火しない。そのため戻り値は Promise<string | null> になる。
 */
export async function extractHtmlTitle(html: string): Promise<string | null> {
  let matched = false;
  let collecting = false;
  let buffer = '';

  const rewriter = new HTMLRewriter().on('title', {
    element: (e) => {
      if (matched) return; // 2つ目以降の title 要素は無視する
      matched = true;
      collecting = true;
      e.onEndTag(() => {
        collecting = false;
      });
    },
    text: (t) => {
      if (!collecting) return;
      buffer += t.text;
    },
  });

  const rewritten = rewriter.transform(new Response(html));
  await rewritten.text();

  if (!matched) return null;
  const normalized = buffer.replace(/\s+/g, ' ').trim();
  if (normalized === '') return null;
  return normalized.length > TITLE_MAX_CHARS ? normalized.slice(0, TITLE_MAX_CHARS) : normalized;
}
