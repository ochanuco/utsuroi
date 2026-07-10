/**
 * public/ (Workers Assets, wrangler.jsonc の assets.directory) と、
 * assets.run_worker_first による /api/* の Worker 優先ルーティングを確認する
 * (docs/SPEC.md §16, §17 受け入れ条件10 の前提となる配信構成)。
 *
 * 既知の制約: @cloudflare/vitest-pool-workers (このリポジトリでは v0.18.2) の `SELF.fetch` は
 * Workers Assets のルーティング層 (run_worker_first に基づき Asset Worker と User Worker を
 * 振り分ける外側のエントリ) を経由せず、User Worker (src/index.ts の fetch handler) を直接叩く。
 * そのため `SELF.fetch('/')` や `SELF.fetch('/app.js')` は常に Hono 側のフォールバック
 * (`/` は `app.get('/', ...)`、それ以外は `app.notFound`) に到達し、実際に public/ 配下の
 * 静的ファイルが返っているかはこのテストでは確認できない。
 *
 * 実際に `public/index.html` / `public/app.js` が assets として配信され、`/api/*` のみ
 * Workerへ渡ることは `wrangler dev` で手動確認済み (report参照)。ここでは
 * vitest-pool-workers で機械的に検証できる範囲、すなわち「assets設定を追加しても
 * /api/* が引き続き Hono (Bearer認証必須) に渡ること」を確認する。
 */
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('web ui assets routing', () => {
  it('/api/* still requires bearer auth after adding assets config (not swallowed by asset routing)', async () => {
    const res = await SELF.fetch('https://example.com/api/sites');
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe('unauthorized');
  });

  it('/api/* with a wrong bearer token is still rejected by the Hono API', async () => {
    const res = await SELF.fetch('https://example.com/api/does-not-exist', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('worker fetch handler still responds for non-API paths (fallback path exercised by vitest-pool-workers)', async () => {
    // 実運用では assets.directory の public/index.html が優先されるが (wrangler dev で確認済み)、
    // SELF.fetch はそのルーティングをバイパスするため、ここでは Worker 自体が引き続き
    // 200 を返す (クラッシュしない) ことだけを保証する。
    const res = await SELF.fetch('https://example.com/');
    expect(res.status).toBe(200);
  });
});
