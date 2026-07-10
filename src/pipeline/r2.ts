/** R2 content-addressed storage helpers (SPEC §13: 同一内容は重複保存しない) */

/** 既存キーが無ければ put する。既存なら何もしない (content-addressed dedupe) */
export async function putIfAbsent(
  bucket: R2Bucket,
  key: string,
  body: Uint8Array | string,
): Promise<void> {
  const existing = await bucket.head(key);
  if (existing) return;
  await bucket.put(key, body);
}

export function bodyKey(sha256Hex: string): string {
  return `bodies/${sha256Hex}`;
}

export function normalizedKey(sha256Hex: string): string {
  return `normalized/${sha256Hex}`;
}

export function diffKey(changeId: string): string {
  return `diffs/${changeId}`;
}

/** 通知プレビュー用に unified diff を切り詰める */
export function truncateDiffPreview(diff: string, maxChars = 2000): string {
  if (diff.length <= maxChars) return diff;
  return `${diff.slice(0, maxChars)}\n… (truncated)`;
}
