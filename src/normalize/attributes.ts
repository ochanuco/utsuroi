import {
  DEFAULT_DYNAMIC_ATTRIBUTES,
  DEFAULT_DYNAMIC_ATTRIBUTE_PATTERNS,
} from './constants';

/**
 * 属性名が「動的属性 (除外対象)」かどうかを判定する。
 *
 * - `overrideList` が指定されている場合 (opts.dynamicAttributes 明示指定時) は
 *   完全一致 (大文字小文字無視) のみで判定し、既定パターンは適用しない。
 * - 省略時は既定の完全一致リスト (nonce, data-nonce) に加えて、
 *   csrf系・timestamp系のパターンにもマッチする属性名を除外する。
 */
export function isDynamicAttribute(name: string, overrideList?: readonly string[]): boolean {
  const lowerName = name.toLowerCase();

  if (overrideList) {
    return overrideList.some((candidate) => candidate.toLowerCase() === lowerName);
  }

  if (DEFAULT_DYNAMIC_ATTRIBUTES.some((candidate) => candidate === lowerName)) {
    return true;
  }
  return DEFAULT_DYNAMIC_ATTRIBUTE_PATTERNS.some((pattern) => pattern.test(lowerName));
}

/** 属性名の配列をアルファベット順 (Unicode コードポイント順) にソートする。 */
export function sortAttributeNames(names: readonly string[]): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
