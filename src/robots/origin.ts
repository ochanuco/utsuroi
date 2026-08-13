/**
 * robots Policy の canonical_origin 正規化 (ADR-0017)。
 *
 * pipeline 側は `new URL(source.url).origin` (末尾スラッシュ無し・ホスト小文字) で
 * Policy を引くのに対し、API/UI からは `https://example.com/` のような末尾スラッシュ付きの
 * 値が入りうる。robots_policies の照合は完全一致なので、両者を同じ表記に寄せないと
 * 設定したはずの Override が引けず既定の enforce にフォールバックする。
 */

/**
 * origin 表記を `scheme://host[:port]` (末尾スラッシュ無し) に正規化する。
 * URL として解釈できない入力は前後の空白だけ落として返す (バリデーションは呼び出し側の責務)。
 */
export function normalizeCanonicalOrigin(input: string): string {
  const trimmed = input.trim();
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed;
  }
}
