/**
 * Webhook URL は平文で返さない (SPEC §14)。ホスト名 + URL末尾4文字のみを表示する。
 */
export function maskWebhookUrl(url: string): string {
  let host = 'invalid-url';
  try {
    host = new URL(url).host;
  } catch {
    // 不正なURLでもマスク表示自体は継続する
  }
  const tail = url.slice(-4);
  return `${host}/***${tail}`;
}
