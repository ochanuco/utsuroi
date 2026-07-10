import { createTwoFilesPatch, diffLines } from 'diff';
import type { DiffLevel, NormalizedContent, TextDiffResult } from '../shared/contracts';

/**
 * before/after のプレーンテキストから unified diff と行単位の増減数を算出する。
 * 差分が無い場合は unifiedDiff を空文字にし changed: false を返す。
 */
export function diffText(before: string, after: string, opts?: { context?: number }): TextDiffResult {
  const context = opts?.context ?? 3;

  const changes = diffLines(before, after);
  let addedCount = 0;
  let removedCount = 0;
  for (const change of changes) {
    if (change.added) {
      addedCount += change.count;
    } else if (change.removed) {
      removedCount += change.count;
    }
  }

  const changed = addedCount > 0 || removedCount > 0;
  const unifiedDiff = changed
    ? createTwoFilesPatch('before', 'after', before, after, undefined, undefined, { context })
    : '';

  return { changed, unifiedDiff, addedCount, removedCount };
}

/**
 * before/after の NormalizedContent を raw → normalized → text の順に比較し、
 * 実質的な変更があったかどうかと、ハッシュが一致しなくなった最深レベルを判定する。
 *
 * 判定意図 (SPEC §12 判定レベル 2〜4 に対応):
 * - rawHash が一致 → 完全に無変更。changed: false, level: null。
 * - rawHash は不一致だが normalizedHash が一致
 *   → tracking query の揺れ・属性順序・空白差分など「正規化で吸収される」バイト差分のみ。
 *     実質的な変更ではないとみなし changed: false, level: null を返す
 *     (raw_hash 単独の不一致では「変更」として扱わない、という仕様上の意図をここで明文化する)。
 * - normalizedHash が不一致だが textHash が一致
 *   → マークアップ・構造のみの変更で、抽出テキストは同一。
 *     changed: true, level: 'normalized_hash'。
 * - textHash も不一致 → 本文テキストが変わった実質的な変更。
 *     changed: true, level: 'text_hash'。
 *
 * (normalizedHash が一致するのに textHash が不一致になることは、
 *  extractedText が normalizedHtml から決定論的に導出される実装である限り発生しない。)
 */
export function compareSnapshots(
  before: NormalizedContent,
  after: NormalizedContent,
): { changed: boolean; level: DiffLevel | null } {
  if (before.rawHash === after.rawHash) {
    return { changed: false, level: null };
  }
  if (before.normalizedHash === after.normalizedHash) {
    return { changed: false, level: null };
  }
  if (before.textHash === after.textHash) {
    return { changed: true, level: 'normalized_hash' };
  }
  return { changed: true, level: 'text_hash' };
}
