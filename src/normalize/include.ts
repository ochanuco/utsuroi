/**
 * includeSelectors マッチ要素の前後に挿入したセンチネルコメントの間の内容だけを
 * 連結して取り出す。
 *
 * センチネルは固定文字列ではなく、呼び出し元 (normalize.ts) が正規化1回ごとに
 * 生成する実行時一意トークン (token) を埋め込んだコメントを使う。固定コメントだと
 * 入力HTML自身に同じコメントが偶然/意図的に含まれていた場合に抽出ロジックの
 * depth カウントが破綻し得るため (例: 攻撃的なページが `<!--utsuroi:include-end-->`
 * を仕込んで抽出範囲を騙る)、token は呼び出しごとに変わり外部から予測できない
 * ことが前提となる。抽出後の結果にセンチネル自体が残ることもない。
 *
 * ネストしたマッチ (include 対象要素の内側にさらに include 対象要素がある場合) にも
 * 対応するため、深さカウンタで開始/終了を追跡し、深さ > 0 の区間のみを採用する
 * (マーカー自体は結果に含めない)。
 */
export function extractIncludedRegions(html: string, token: string): string {
  const markerRe = new RegExp(`<!--utsuroi:include-(start|end):${token}-->`, 'g');

  let depth = 0;
  let result = '';
  let lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = markerRe.exec(html)) !== null) {
    if (depth > 0) {
      result += html.slice(lastIndex, match.index);
    }
    if (match[1] === 'start') {
      depth += 1;
    } else {
      depth = Math.max(0, depth - 1);
    }
    lastIndex = markerRe.lastIndex;
  }

  if (depth > 0) {
    result += html.slice(lastIndex);
  }

  return result;
}

/** 指定トークンに対応する include 区間の開始/終了マーカー (HTMLコメント) を組み立てる */
export function buildIncludeMarkers(token: string): { start: string; end: string } {
  return {
    start: `<!--utsuroi:include-start:${token}-->`,
    end: `<!--utsuroi:include-end:${token}-->`,
  };
}
