# utsuroi

## デプロイ

本番へのデプロイはどちらも GitHub Actions の手動実行で、入力 `ref` は `main` か main 上のコミット SHA に限る。Environment `production` の承認後に動く。

- Worker: `deploy` workflow が `scripts/deploy.sh production`（`pnpm exec wrangler deploy`）を実行する。`wrangler deploy` の手打ちはしない。
- GCP Executor（Cloud Run）: `Deploy GCP Executor` workflow がイメージを build して Cloud Run に反映する。GCP へは Workload Identity Federation で認証する。
- Home Runner のイメージ: `Publish Home Runner` workflow が `executors/home-runner` などの変更を main に merge すると GHCR へ公開する（デプロイは別の infra リポジトリ）。

D1 migration はどのデプロイでも適用しない。migration を含む PR ごとに手で `pnpm exec wrangler d1 migrations apply utsuroi --remote` を実行する。
