import { INCLUDE_END_MARKER, INCLUDE_START_MARKER } from './constants';

const MARKER_RE = /<!--utsuroi:include-(start|end)-->/g;

/**
 * includeSelectors マッチ要素の前後に挿入したセンチネルコメント
 * (INCLUDE_START_MARKER / INCLUDE_END_MARKER) の間の内容だけを連結して取り出す。
 *
 * ネストしたマッチ (include 対象要素の内側にさらに include 対象要素がある場合) にも
 * 対応するため、深さカウンタで開始/終了を追跡し、深さ > 0 の区間のみを採用する
 * (マーカー自体は結果に含めない)。
 */
export function extractIncludedRegions(html: string): string {
  let depth = 0;
  let result = '';
  let lastIndex = 0;
  MARKER_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MARKER_RE.exec(html)) !== null) {
    if (depth > 0) {
      result += html.slice(lastIndex, match.index);
    }
    if (match[1] === 'start') {
      depth += 1;
    } else {
      depth = Math.max(0, depth - 1);
    }
    lastIndex = MARKER_RE.lastIndex;
  }

  if (depth > 0) {
    result += html.slice(lastIndex);
  }

  return result;
}

export { INCLUDE_START_MARKER, INCLUDE_END_MARKER };
