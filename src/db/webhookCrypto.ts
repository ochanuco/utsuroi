/**
 * destinations.webhook_url の暗号化保存 (SPEC §15「Secretsまたは暗号化済み参照」)。
 *
 * 平文の webhook URL を DB カラムへそのまま保存しないよう、AES-256-GCM で暗号化した
 * 文字列をカラムへ書き込む。カラム型は変更しない (TEXT のまま、`enc:v1:...` という
 * 自己記述的な文字列を格納する)。
 *
 * 保存フォーマット: `enc:v1:<maskedB64>:<ivB64>:<ciphertextB64>`
 * - maskedB64: 表示用マスク文字列 (例: "discord.com/***WxYz", src/api/mask.ts と同じ
 *   アルゴリズムで暗号化前に計算した値) を base64 で埋め込んだもの。GET/list API が
 *   マスク表示のためだけに毎回鍵で復号する必要が無いようにするための設計判断。
 * - ivB64: AES-GCM の 96bit (12 byte) IV。
 * - ciphertextB64: 暗号文 (GCM 認証タグ込み)。
 *
 * 鍵は env.WEBHOOK_ENC_KEY (base64 エンコードされた 32 byte の生鍵) を想定する。
 */

const ENC_PREFIX = 'enc:v1:';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importWebhookEncKey(keyB64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(keyB64);
  if (raw.length !== 32) {
    throw new Error('WEBHOOK_ENC_KEY must decode to exactly 32 bytes (AES-256-GCM)');
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** stored 値がこのモジュールの暗号化フォーマットかどうかを判定する */
export function isEncryptedWebhookUrl(stored: string): boolean {
  return stored.startsWith(ENC_PREFIX);
}

/**
 * 平文 webhook URL を暗号化して保存用文字列を作る。
 * masked には src/api/mask.ts の maskWebhookUrl(plainUrl) の結果を渡す想定
 * (表示用マスクの算出ロジックを1箇所に保つため、ここでは再計算しない)。
 */
export async function encryptWebhookUrl(
  plainUrl: string,
  masked: string,
  keyB64: string,
): Promise<string> {
  const key = await importWebhookEncKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plainUrl)),
  );
  const maskedB64 = bytesToBase64(new TextEncoder().encode(masked));
  return `${ENC_PREFIX}${maskedB64}:${bytesToBase64(iv)}:${bytesToBase64(ciphertext)}`;
}

/** 保存された暗号文を復号し、平文 webhook URL を返す (送信直前にのみ呼ぶ想定) */
export async function decryptWebhookUrl(stored: string, keyB64: string): Promise<string> {
  if (!isEncryptedWebhookUrl(stored)) {
    throw new Error('decryptWebhookUrl: value is not in the expected enc:v1:... format');
  }
  const parts = stored.slice(ENC_PREFIX.length).split(':');
  const [, ivB64, ctB64] = parts;
  if (parts.length !== 3 || !ivB64 || !ctB64) {
    throw new Error('decryptWebhookUrl: malformed encrypted webhook_url envelope');
  }
  const key = await importWebhookEncKey(keyB64);
  const iv = base64ToBytes(ivB64);
  const plainBytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    base64ToBytes(ctB64),
  );
  return new TextDecoder().decode(plainBytes);
}

/** 暗号文に埋め込まれた表示用マスク文字列だけを、鍵無しで (同期的に) 取り出す */
export function extractMaskedWebhookUrl(stored: string): string {
  if (!isEncryptedWebhookUrl(stored)) {
    throw new Error('extractMaskedWebhookUrl: value is not in the expected enc:v1:... format');
  }
  const parts = stored.slice(ENC_PREFIX.length).split(':');
  const maskedB64 = parts[0];
  if (!maskedB64) {
    throw new Error('extractMaskedWebhookUrl: malformed encrypted webhook_url envelope');
  }
  return new TextDecoder().decode(base64ToBytes(maskedB64));
}
