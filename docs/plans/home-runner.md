# Home Runner 実装計画

ADR-0023（Home Runnerのpullプロトコル）を実装するためのPR分割。各PRは単独でmainへマージでき、マージ時点で既存の挙動を変えない。`home-http` が実際に使われるのは、PR 4までがマージされ、`RUNNER_EXECUTORS` を設定し、SiteのAllowListへ `home-http` を追加した後である。

## 依存関係

| PR | タイトル | 依存 |
|---|---|---|
| 1 | `feat: add executor_unavailable failure class` | なし |
| 2 | `feat: add CrawlerObject for pull-based executors` | なし |
| 3 | `feat: add /api/runner endpoints for home runner` | 2 |
| 4 | `feat: add home-http fetcher backed by CrawlerObject` | 1, 2, 3 |
| 5 | `feat: add executor status API` | 2 |
| 6 | `refactor: extract SSRF-safe fetch shared by executors` | なし |
| 7 | `feat: add home runner` | 3, 6 |
| 8 | `ci: publish home runner image to ghcr` | 7 |
| 9 | `docs: document home runner in SPEC and runbook` | 4, 7 |

PR1、PR2、PR6は並行して着手できる。

## PR1: `executor_unavailable` 失敗分類

目的: Runner不在や期限切れを、取得先の失敗と区別して扱えるようにする（ADR-0023 §2）。

| ファイル | 変更 |
|---|---|
| `src/shared/types.ts` | `FailureClass` に `executor_unavailable` を追加。`DEFAULT_PROCEEDABLE_FAILURES` に追加 |
| `src/fetch/policy.ts` | 変更なしを確認する（`TRANSIENT_RETRY_FAILURE_CLASSES` に入れない） |
| `src/do/hostObject.ts` | `release` で `executor_unavailable` のときは `failureStreak` を増やさず、リセットもしない |
| `src/api/routes/sites.ts` | `proceedOn` の許可値リストに追加 |
| `test/fetch/policy.test.ts` ほか | 既定で次のFetcherへ進むこと、エントリ内リトライされないこと |
| `test/do/hostObject.test.ts` | `executor_unavailable` でbackoffとcircuit breakerが動かないこと |

検証: `pnpm typecheck && pnpm test`

## PR2: CrawlerObject

目的: `executor_id` 単位のjob投入、lease、結果の受け渡し、heartbeatを1つのDOに実装する（ADR-0023 §1、§3）。HTTPのルートはまだ作らない。

| ファイル | 変更 |
|---|---|
| `src/do/crawlerObject.ts` | 新規。SQLiteの `jobs`、`runners` テーブル。RPCメソッドは下記 |
| `src/shared/env.ts` | `CRAWLER_DO: DurableObjectNamespace` |
| `src/index.ts` | `CrawlerObject` をexport |
| `wrangler.jsonc` | `durable_objects.bindings` に `CRAWLER_DO`、`migrations` にタグ `v2` の `new_sqlite_classes: ["CrawlerObject"]` |
| `test/do/crawlerObject.test.ts` | 下記の振る舞い |
| `test/env.d.ts` | binding の型 |

RPCメソッド（名前は実装時に調整してよい）:

- `submitAndWait(job, limits)`: Runnerの生存確認 → `queued` で保存 → 待機中のlease要求があれば起こす → 結果か期限まで待つ。戻り値は `{kind: 'result', result} | {kind: 'unavailable', reason}`。
- `lease(runner, max, waitMs, fetchModes)`: `queued` を `leased` にして `leaseToken` を発行（ハッシュを保存）。無ければ `waitMs` まで待つ。heartbeatとしても記録する。
- `complete(jobId, leaseToken, result)`: トークン照合、状態遷移、待機中の `submitAndWait` へ結果を渡す。戻り値は `accepted | duplicate | lease_mismatch | lease_expired | not_found`。
- `heartbeat(runner)`: `runners` を更新し、`maintenance` を返す（`executors.status` はD1から読む）。
- `status()`: PR5の観測API用の集計。
- `alarm()`: 期限切れjobの `expired` 化、終端から1時間経ったjobと24時間heartbeatの無いrunnerの削除、オンライン・オフライン遷移のログ。

振る舞いとして固定するもの（テスト対象）:

- 直近heartbeatが60秒より古ければ投入せず `unavailable`。
- lease待ち10秒、lease後40秒で `expired`、待機側は `unavailable`。
- lease後の期限切れが起きたら、そのRunnerを次の接触までオフライン扱いにする。
- 1つのjobは一度しかleaseされない。
- 同じトークンでの再送は `duplicate`、違うトークンは `lease_mismatch`、期限後は `lease_expired`。
- 結果本文はストレージに書かない。
- `fetchModes` に合わないjobはleaseしない。

検証: `pnpm typecheck && pnpm test`

## PR3: `/api/runner/*`

目的: RunnerがWorkerと話すHTTP APIと、Runnerトークンの権限の閉じ込め（ADR-0023 §4）。

| ファイル | 変更 |
|---|---|
| `src/runner/protocol.ts` | 新規。heartbeat、lease、resultのリクエスト・応答のzodスキーマと型。`Utsuroi-Runner-Protocol` の版定数 |
| `src/api/runnerAuth.ts` | 新規。`RUNNER_EXECUTORS` を解釈し、caller → executor id を引く。不正なJSONは空の対応表として扱い、エラーログを出す |
| `src/api/auth.ts` | Runnerのcallerが `/api/runner/*` 以外へ来たら403。既存のcaller解決は変えない |
| `src/api/routes/runner.ts` | 新規。`POST heartbeat`、`POST lease`、`POST jobs/:jobId/result`。本文サイズ上限（`maxBytes` のbase64換算＋64KiB）を超えたら413 |
| `src/api/index.ts` | `app.route('/api/runner', runnerRoutes())` |
| `src/shared/env.ts` | `RUNNER_EXECUTORS: string` |
| `wrangler.jsonc` | `RUNNER_EXECUTORS: "{}"`（有効化は運用で `{"runner-home":"home"}` にする） |
| `test/fixtures/runner-protocol/*.json` | 新規。各リクエスト・応答の代表例。PR7のRunner側テストも同じファイルを読む |
| `test/api/runner.test.ts` | 下記 |

テストで固定するもの:

- 人間のcaller、対応表に無いトークンは `/api/runner/*` で403。
- Runnerのcallerは `/api/sites` などで403。
- `executorId` の不一致は403。プロトコル版ヘッダが無い、または未知なら400。
- lease → result の往復（テスト内の偽Runnerが `SELF.fetch` で叩く。Access JWTは既存の認証テストと同じテスト用鍵で署名する）。
- fixtureがスキーマに通ること。

検証: `pnpm typecheck && pnpm test`

## PR4: `home-http` Fetcher

目的: Fetcher Policyから `home-http` を選べるようにする（ADR-0023 §1、§5、§8）。

| ファイル | 変更 |
|---|---|
| `src/fetch/homeHttp.ts` | 新規。`urlGuard` で静的検査 → jobを組み立て（ヘッダは許可リストのみ、`maxBytes` は `DEFAULT_FETCH_LIMITS`）→ `CRAWLER_DO.idFromName(executorId)` へ `submitAndWait`。`kind: "response"` は `handleTerminalResponse` で分類し、最終URLを `checkUrlForSsrf` で再検査。`kind: "error"` の分類はGCP Executorと同じ許可集合に限り、それ以外は `internal_error`。RPC例外は `executor_unavailable` |
| `src/fetch/gcpHttp.ts` | 応答本文の解釈（`kind: "response"` → `FetchOutcome`）を共通関数に切り出し、`homeHttp.ts` と共有する |
| `src/fetch/registry.ts` | `['home-http', homeHttpFetch]` を登録。`FetcherInvocation` に任意の `jobRef`（check job id、attempt index）を足し、job idの記録に使う |
| `src/pipeline/fetchTarget.ts` | 1チェック内で `executor_unavailable` になったFetcherを `CheckContext` に記録し、以降は投入せず即 `executor_unavailable` を返す。`createCheckAttempt` に `executorJobId` を渡す |
| `src/pipeline/types.ts` | `CheckContext` に `unavailableFetchers: Set<string>` |
| `src/db/jobs.ts`、`src/db/types.ts` | `check_attempts.executor_job_id` の読み書き |
| `src/api/routes/jobs.ts` | attemptsの応答に `executor_job_id` |
| `migrations/00NN_home_runner.sql` | 番号は次の空き番号（執筆時点では `0010`）。Executor `home`（kind `home_runner`、capabilities `{"fetch_modes":["http"]}`）、Fetcher `home-http`（`executor_id` `home`、fetch mode `http`、region NULL）、`ALTER TABLE check_attempts ADD COLUMN executor_job_id TEXT` |
| `test/fetch/homeHttp.test.ts` | 分類（200、304、403、429、5xx、truncated、Runnerの `ssrf_blocked`、最終URLがprivate）、Runner不在、期限切れ |
| `test/pipeline/homeRunner.test.ts` | OrderList `[home-http, cf-http]` でRunner不在 → `cf-http` へ進む。偽Runnerが応答 → Snapshotが作られる。Sitemap探索で一度 `executor_unavailable` になったら以降の子は投入されない |

検証: `pnpm typecheck && pnpm test`

## PR5: Executorの状態API

目的: Runnerのオンライン・オフラインと処理状況を `/api` から見る（ADR-0023 §7）。

| ファイル | 変更 |
|---|---|
| `src/api/routes/executors.ts` | 新規。`GET /api/executors`、`GET /api/executors/:id`。D1の `executors` に、`kind = home_runner` ならCrawlerObjectの `status()` を合わせる |
| `src/api/index.ts` | ルート登録 |
| `src/db/executors.ts` | 必要なら `status` の型 |
| `test/api/executors.test.ts` | heartbeat直後は `online: true`、61秒後は `false`、`cloud_run` には `online` が無い |

UIへの表示（バッジ等）はこのPRに含めない。

検証: `pnpm typecheck && pnpm test`

## PR6: SSRF検査付き取得の共有化

目的: GCP Executorの取得処理とアドレス判定を、Home Runnerと共有できる場所へ移す（ADR-0023 §6）。挙動は変えない。

| ファイル | 変更 |
|---|---|
| `executors/shared/src/addressPolicy.ts`、`executors/shared/src/fetcher.ts` | `executors/gcp-http/src/` から移動。`isBlockedAddress` に追加CIDRを受け取る引数を足す（既定は空） |
| `executors/shared/test/*` | `executors/gcp-http/test/addressPolicy.test.ts`、`fetcher.test.ts` を移動 |
| `executors/gcp-http/src/server.ts` | importを `../../shared/src/...` へ |
| `executors/gcp-http/Dockerfile` | ビルドコンテキストを `executors/` にしたうえで `shared/` と `gcp-http/` をコピー |
| `executors/gcp-http/tsconfig*.json` | `shared` を含める |
| `.github/workflows/deploy-gcp-executor.yml` | `paths` に `executors/shared/**`、`docker build` のコンテキストとDockerfile指定 |
| `.github/workflows/ci.yml` | `gcp-executor` ジョブで `shared` のテストも走らせる |

検証: `cd executors/gcp-http && npm test`、`docker build -f executors/gcp-http/Dockerfile executors`

## PR7: Home Runner本体

目的: 宅内のDocker Composeから環境変数だけで動かせるRunner（ADR-0023 §4、§5、§6）。

| ファイル | 変更 |
|---|---|
| `executors/home-runner/package.json`、`tsconfig*.json` | gcp-httpと同じ構成（Node 22、依存はTypeScriptのみ） |
| `executors/home-runner/src/config.ts` | 環境変数の読み込みと検証。必須が欠けたら起動時に終了 |
| `executors/home-runner/src/client.ts` | `/api/runner/*` のクライアント。`CF-Access-Client-Id`、`CF-Access-Client-Secret`、`Utsuroi-Runner-Protocol: 1` を付ける。結果の再送は5xxとネットワークエラーのみ |
| `executors/home-runner/src/runner.ts` | leaseのlong-pollループ、並行実行、heartbeat、SIGTERMでの停止 |
| `executors/home-runner/src/addressPolicy.ts` | 共有のアドレス判定に `BLOCKED_CIDRS` を足し、`ALLOW_IPV6=false` ならIPv6の解決結果を使わない |
| `executors/home-runner/src/health.ts` | `GET /healthz` と、`HEALTHCHECK` から呼ぶ `healthcheck.js` |
| `executors/home-runner/src/main.ts` | 起動 |
| `executors/home-runner/test/*` | 偽サーバーに対するlease → 実行 → 結果、409で再送しない、401でバックオフ、healthzの200/503、`BLOCKED_CIDRS`、`test/fixtures/runner-protocol/*.json` との整合 |
| `executors/home-runner/Dockerfile` | ビルドコンテキスト `executors/`。非rootユーザー、`HEALTHCHECK`、`ARG GIT_SHA` をversionとして埋める |
| `.github/workflows/ci.yml` | `home-runner` ジョブ |

検証: `cd executors/home-runner && npm test`、`docker build -f executors/home-runner/Dockerfile executors`

## PR8: イメージの公開

| ファイル | 変更 |
|---|---|
| `.github/workflows/publish-home-runner.yml` | 新規。`main` へのpush（`executors/home-runner/**`、`executors/shared/**`）と `workflow_dispatch`。テスト → `docker/build-push-action` で `ghcr.io/ochanuco/utsuroi-runner:<sha>` と `:latest` をpush。`permissions: packages: write`、actionはSHA固定 |

マージ後、GHCRのパッケージをpublicにする（初回のみ手作業）。

## PR9: 文書

| ファイル | 変更 |
|---|---|
| `docs/SPEC.md` | §5に `executor_unavailable`、§11のCrawlerObjectにjob・lease・期限、§15にRunnerトークンの権限とRunner側SSRF |
| `docs/runbooks/home-runner.md` | 新規。環境変数一覧、Accessサービストークンの発行と `ACCESS_CALLERS`・`RUNNER_EXECUTORS` の設定、`/api/executors` での確認、スモークテストの手順 |

## 導入手順（マージ後の運用作業）

1. PR4のマイグレーションを本番D1へ適用する（Worker のデプロイ前）。
2. `RUNNER_EXECUTORS` を `{"runner-home":"home"}` にしてデプロイする。`ACCESS_CALLERS` にはRunnerのClient IDが登録済みであること、Accessアプリケーションでそのサービストークンを許可するService Authポリシーがあることを確認する。
3. infraリポジトリでRunnerをComposeに追加する。環境変数は `UTSUROI_BASE_URL`、`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET`、`EXECUTOR_ID=home`、`CONCURRENCY`。
4. `GET /api/executors/home` で `online: true` を確認する。
5. スモークテスト: `https://example.com/` を監視するテスト用Siteを作り、AllowList・OrderListを `[home-http, cf-http]` にして手動実行する。`GET /api/jobs/:id/attempts` で `home-http` の成功と `executor_job_id` を確認する。Runnerを止めて再度手動実行し、`executor_unavailable` の後に `cf-http` で成功することを確認する。
6. 実運用のSiteのAllowList・OrderListへ `home-http` を追加する。

## 実ホスト無しでの確認

- Worker側: PR3、PR4のテストで、テスト内の偽Runnerが `SELF.fetch` 経由で `/api/runner/*` を叩き、lease → result → Snapshot作成までを通す。
- Runner側: PR7のテストで、Node内の偽サーバーに対してRunnerを動かす。
- 両者の整合: 共通の `test/fixtures/runner-protocol/*.json` をWorker側のzodスキーマとRunner側のパーサの両方に通す。
- 結合: 手元でRunnerのコンテナを起動し、本番Workerに対して導入手順の5を行う。Runnerはjobが投入されない限り何も取得しないため、テスト用Siteだけで確認できる。
