/**
 * HTML から `<title>` テキストを抽出する (ADR-0016 Enrich段 title enrich)。
 * normalize.ts と同じ HTMLRewriter 利用パターン (Response 経由で transform)。
 */

/** タイトル文字列の最終的な上限。超過分は切り詰める */
const TITLE_MAX_CHARS = 512;

/**
 * text ハンドラでの収集上限。TITLE_MAX_CHARS (512) より大きめに取り、空白正規化
 * (連続空白の圧縮) で縮む分の余地を残しつつ、異常に長い title 要素でバッファが
 * 際限なく伸びるのを防ぐ (直後に normalize+truncate するため、収集自体をここで頭打ちにできる)。
 */
const COLLECT_BUFFER_MAX_CHARS = 2048;

/** 上位サロゲート (High Surrogate) の範囲判定 */
function isHighSurrogate(charCode: number): boolean {
  return charCode >= 0xd800 && charCode <= 0xdbff;
}

/**
 * text を maxChars (UTF-16 コード単位) で切り詰める。切り詰め位置が孤立した上位サロゲートに
 * かかる場合は、その1文字ごと落とす (絵文字等のサロゲートペアを分断しない)。
 */
function truncateAtCodeUnitBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  const lastCode = sliced.charCodeAt(sliced.length - 1);
  return isHighSurrogate(lastCode) ? sliced.slice(0, -1) : sliced;
}

/**
 * html 内の最初の `<title>` 要素のテキストを抽出する。2つ目以降の title 要素は無視する。
 * 空白・改行は半角スペース1つに正規化し前後を trim する。空文字・title 要素なしは null。
 *
 * HTMLRewriter (workerd 組み込み) の変換はストリーム消費まで遅延される (normalize.ts /
 * extractItems.ts と同じ挙動) ため、ボディを読み切るまで element/text ハンドラが発火しない。
 * ハンドラを駆動するためだけにストリームを消費する必要があるが、変換後 HTML 全体を第2の
 * 文字列として保持する必要はない (title 要素のテキストは text ハンドラ内の buffer に
 * 既に集めている) ため、`await rewritten.text()` ではなく reader ループでチャンクを
 * 読み捨てる。そのため戻り値は Promise<string | null> になる。
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
      if (!collecting || buffer.length >= COLLECT_BUFFER_MAX_CHARS) return;
      buffer += t.text;
    },
  });

  const rewritten = rewriter.transform(new Response(html));
  await drainBody(rewritten.body);

  if (!matched) return null;
  const normalized = buffer.replace(/\s+/g, ' ').trim();
  if (normalized === '') return null;
  return truncateAtCodeUnitBoundary(normalized, TITLE_MAX_CHARS);
}

/**
 * HTMLRewriter ハンドラを駆動する目的だけでストリームを最後まで読み切り、
 * チャンクの中身は保持せず読み捨てる (`await response.text()` は変換後 HTML 全体を
 * 第2の文字列として保持してしまうため避ける)。
 */
async function drainBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}
