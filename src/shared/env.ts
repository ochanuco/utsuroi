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
}
