import type { NotifyQueueMessage } from './contracts';

export interface Env {
  DB: D1Database;
  BODIES: R2Bucket;
  NOTIFY_QUEUE: Queue<NotifyQueueMessage>;
  MONITOR_DO: DurableObjectNamespace;
  HOST_DO: DurableObjectNamespace;
  USER_AGENT: string;
  /** Cloudflare Access のチームドメイン (例: example.cloudflareaccess.com)。JWKS と iss の検証に使う */
  ACCESS_TEAM_DOMAIN: string;
  /** Access アプリケーションの AUD タグ。空の間は全 /api リクエストを拒否する */
  ACCESS_AUD: string;
  /** サービストークンの Client ID -> 呼び出し元名の JSON オブジェクト。マップに無い Client ID は 403 */
  ACCESS_CALLERS: string;
  /**
   * destinations.webhook_url を AES-256-GCM で暗号化保存するための鍵 (wrangler secret)。
   * base64 エンコードされた 32 byte の生鍵を想定する (SPEC §15「Secretsまたは暗号化済み参照」)。
   * 未設定時は destination 作成 API を 503 で拒否する (平文フォールバックはしない)。
   */
  WEBHOOK_ENC_KEY?: string;
  /**
   * GCP Executor (Cloud Run, fetcher 'gcp-http') のエンドポイント URL。空の間は gcp-http が
   * internal_error を返す (ADR-0021)。
   */
  GCP_EXECUTOR_URL?: string;
  /**
   * GCP Executor へのリクエストに署名する Ed25519 秘密鍵 (wrangler secret, PKCS8 PEM)。
   * 公開鍵は Cloud Run 側の EXECUTOR_PUBLIC_KEY と対になる。
   */
  GCP_EXECUTOR_SIGNING_KEY?: string;
  /**
   * Service Binding 経由の RPC (FetchEntrypoint, ADR-0022) を許可する呼び出し元の設定 (wrangler secret)。
   * JSON: { "<caller>": { "allowedHosts": string[], "fetchers": string[] } }。
   * 未設定・不正な JSON の間は全 RPC 呼び出しを拒否する。
   */
  RPC_CALLERS?: string;
}
