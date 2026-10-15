# utsuroi

## デプロイ

- Worker: main へのマージで、GitHub Actions の `deploy` workflow が本番に出す。承認が要るのは、前回の記録がない・ロールバック・手作業の要る変更（D1 migration など）を含むときだけで、Environment `production-approval` で止まる。何が出るかと承認の要否は、run の `plan` ジョブの Job Summary に出る。手動実行（入力 `ref` は main か main 上のコミット SHA）はロールバック用。`scripts/deploy.sh production`（`pnpm exec wrangler deploy`）を実行する。`wrangler deploy` の手打ちはしない。
- GCP Executor（Cloud Run）: `Deploy GCP Executor` workflow を手動で実行し、イメージを build して Cloud Run に反映する。入力 `ref` は `main` か main 上のコミット SHA に限る。GCP へは Workload Identity Federation で認証する。
- Home Runner のイメージ: `Publish Home Runner` workflow が `executors/home-runner` などの変更を main に merge すると GHCR へ公開する（デプロイは別の infra リポジトリ）。

D1 migration はどのデプロイでも適用しない。migration を含む PR ごとに手で `pnpm exec wrangler d1 migrations apply utsuroi --remote` を実行する。
