import type { NotifyQueueMessage } from './contracts';

export interface Env {
  DB: D1Database;
  BODIES: R2Bucket;
  NOTIFY_QUEUE: Queue<NotifyQueueMessage>;
  MONITOR_DO: DurableObjectNamespace;
  HOST_DO: DurableObjectNamespace;
  USER_AGENT: string;
  /** 管理APIの Bearer トークン (wrangler secret)。未設定時はAPIを拒否する */
  ADMIN_TOKEN?: string;
  /**
   * destinations.webhook_url を AES-256-GCM で暗号化保存するための鍵 (wrangler secret)。
   * base64 エンコードされた 32 byte の生鍵を想定する (SPEC §15「Secretsまたは暗号化済み参照」)。
   * 未設定時は destination 作成 API を 503 で拒否する (平文フォールバックはしない)。
   */
  WEBHOOK_ENC_KEY?: string;
}
