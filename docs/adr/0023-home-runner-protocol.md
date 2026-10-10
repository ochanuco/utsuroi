# ADR-0023: Home Runnerのpullプロトコル（CrawlerObjectでlease管理、チェックは結果を同期待機する）

- **Status**: Proposed
- **Date**: 2026-10-10

## Context

ADR-0021で、宅内のHome Runnerはpull型とすることを決めた。宅内ホストは外から到達できないため、RunnerがWorkerへjobを取りに行き、結果を返す。実装は後続とされていた。

前提は次のとおり。

- RunnerはDocker Composeで宅内ホストに置く。外向き通信だけを使い、inbound tunnelは開けない。デプロイは別のinfraリポジトリが行う。
- RunnerはCloudflare Accessのサービストークンで認証する。ADR-0020により、Workerはこれを caller `token:runner-home` として識別する。
- Runnerは独自のスケジュールを持たず、Worker側が発行したjobだけを実行する（ADR-0001）。leaseとheartbeatはWorker側のCrawlerObject（`executor_id`単位）が管理する（ADR-0002、SPEC §11）。
- 最初の版はHTTP取得だけを扱う。Fetcher `home-http`、Executor `home`（kind `home_runner`）とする。Browser取得は後から足せるようにする。

チェックの実行は、MonitorObjectのAlarm（または手動実行のRPC）の中で `runMonitorCheck` が `fetchTargetThroughPolicy` → `runFetchSequence` を呼び、各Fetcherの `FetchOutcome` を同期的に `await` する形になっている。Sitemap探索（ADR-0010）では1チェックの中で最大50回の子Sitemap取得がこの経路を通る。pull型では結果がRunnerから非同期に届くため、この同期的な流れとどう接続するかを決める必要がある。

## Decision

### 1. チェックはRunnerの結果を上限付きで同期待機する

`home-http` のFetcher実装は、CrawlerObjectへjobを投入し、結果が届くか期限が来るまでRPCで待つ。ADR-0021のレジストリ契約（`FetcherInvocation` を受け取り `FetchOutcome` を返す関数）をそのまま満たし、パイプライン、`runFetchSequence`、OrderListの扱いは変えない。

期限は次のとおりとする。

| 段階 | 上限 | 超過時 |
|---|---|---|
| 投入時のRunner生存確認 | 直近heartbeatが60秒以内 | 投入せず即 `executor_unavailable` |
| lease待ち（投入からRunnerが取得するまで） | 10秒 | jobを`expired`にして `executor_unavailable` |
| lease後（取得から結果受領まで） | 40秒 | jobを`expired`にして `executor_unavailable` |

合計の最大待ち時間は50秒で、HostObjectのlease TTL（60秒）に収まる。待機中はI/O待ちなのでCPU時間を消費しない。DO Alarmのwall time上限（15分）に対しては、1チェック内で一度 `executor_unavailable` になったFetcherを同じチェックの残りの取得では投入せず即失敗させることで、Sitemap探索でも待ちが積み上がらないようにする。また、lease後の期限切れが起きたRunnerは、次にleaseかheartbeatが届くまでオフラインとみなし、他のチェックからの投入も即失敗させる。

検討した代替案:

- 継続（continuation）方式: Fetcherは「保留」を返してチェックを中断し、結果到着時にMonitorObjectがチェックを再開する。待ち時間に上限が要らず、Browser取得のような長い処理に向く。一方で、robots判定、Host lease、Sitemap探索の再帰状態など、チェック途中の状態をすべて永続化して再開可能にする必要があり、パイプライン全体の書き換えになる。HTTP取得は数秒で終わるため、現時点では見合わない。
- Queue方式: Cloudflare QueuesでjobをRunnerへ渡す。Runnerが外部からQueueを消費するにはAccessとは別のCloudflare APIトークンが要り、結果の受け渡しは結局別の経路が必要になる。採用しない。

プロトコル（lease、heartbeat、result）はWorker側の待ち方に依存しない。Browser取得で待ち時間が長くなった場合は、Fetcher実装を継続方式に差し替えても、Runnerとのプロトコルは変えずに済む。

### 2. 新しい失敗分類 `executor_unavailable`

Runnerがオフライン、lease待ちの期限切れ、lease後の期限切れ、CrawlerObjectのリセットによる待機の中断は、すべて `executor_unavailable` とする。

- `DEFAULT_PROCEEDABLE_FAILURES` に加える。OrderListで `home-http` の後ろに別のFetcherがあれば、既定でそちらへ進む。
- ADR-0014のエントリ内リトライの対象にしない。同じRunnerへ再投入しても期限分待つだけになるため。
- HostObjectへのreleaseでは成功とも失敗とも数えない。取得先hostではなく実行基盤の問題なので、host単位のbackoffやcircuit breakerを動かさない。

既存の `timeout` や `network_error` を流用しない理由は二つある。`network_error` はエントリ内リトライの対象で、期限待ちを3回繰り返してしまう。どちらもHostObjectの失敗連続回数に数えられ、Runnerの停止が取得先hostのcircuit breakerを開いてしまう。

Runner自身が取得を試みた結果は、GCP Executorと同じ分類に従う（ADR-0021 §3）。Runnerは取得先の応答を `kind: "response"` で返し、Workerが `handleTerminalResponse` で分類する。取得に至らなかった場合は `kind: "error"` で `ssrf_blocked`、`timeout`、`network_error`、`too_large` のいずれかを返す。

### 3. jobとleaseはCrawlerObjectのストレージに置く

CrawlerObjectは `executor_id`（`home`）をキーにしたSQLiteストレージ付きDurable Objectとする。jobはチェックの待機が続く間だけ意味を持つ短命なデータで、排他（1つのjobを1つのRunnerだけが取る）とRunnerの生存管理はDOの単一実行で自然に書けるため、D1には置かない。長期の記録はD1の `check_attempts` に残し、`executor_job_id` 列でjobと対応付ける。

CrawlerObjectが持つもの:

| データ | 内容 | 保持期間 |
|---|---|---|
| `jobs` | `job_id`、`fetch_mode`、payload（URL、ヘッダ、`maxBytes`）、状態（`queued`、`leased`、`completed`、`expired`）、`lease_token` のSHA-256、`runner_id`、各時刻と期限 | 終端状態になってから1時間でAlarmが削除する |
| `runners` | `runner_id` ごとの直近heartbeat時刻、version、対応fetch mode、concurrency、実行中job数 | 24時間heartbeatが無ければ削除する |
| 集計 | 直近1時間の完了・期限切れ・拒否の件数 | 時間窓で入れ替える |

結果の本文は永続化しない。Workerが受け取った結果は、CrawlerObjectのメモリ上で待機中のRPCへそのまま渡す。待機しているRPCが無い（期限切れ、DOのリセットで待機が失われた）場合、結果は使い道が無いので捨てる。

検討した代替案:

- D1にjobsテーブルを置く: leaseの排他を条件付きUPDATEで書け、`/api` からの参照も容易になる。一方で待機中のRPCへの通知手段が無く、ポーリングが必要になる。SPEC §4.2とADR-0002もleaseとcapacityをDOの責務としている。
- 結果本文をR2に置く: DOのリセットをまたいで結果を拾い直せる。ただしリセット時には待機側のRPCも失われるため、拾い直す相手がいない。孤児オブジェクトの掃除とlifecycle設定も要る。継続方式（§1）を導入する時点で再検討する。

### 4. Runner向けAPI

`/api/runner/*` に置き、ADR-0020のAccess JWT検証の内側で動かす。

認可:

- vars `RUNNER_EXECUTORS` に、サービストークンの呼び出し元名からexecutor idへの対応をJSONで持つ（例: `{"runner-home":"home"}`）。callerが `token:<name>` でこの対応表に載っている場合だけ `/api/runner/*` を許可する。人間のcallerや対応表に無いトークンは403。
- 対応表に載ったRunnerのトークンは `/api/runner/*` 以外の `/api/*` を403にする。宅内ホストに置くトークンが漏れても、管理APIは操作できない。
- リクエストの `executorId` が対応表から引いた値と一致しなければ403。CrawlerObjectは対応表から引いた側のidで選ぶ。

共通: リクエストヘッダ `Utsuroi-Runner-Protocol: 1` を必須とし、未知の版は400 `unsupported_protocol` で拒否する。

`POST /api/runner/heartbeat`

```json
{ "executorId": "home", "runnerId": "<起動ごとのUUID>", "version": "<git sha>",
  "fetchModes": ["http"], "concurrency": 2, "inflight": ["<job_id>"] }
```

応答は `{"serverTime": "...", "maintenance": false}`。`maintenance` は D1 の `executors.status` が `maintenance` のとき true で、Runnerは新規leaseを止める。`inflight` はv1では観測用で、将来Browser取得でlease延長の要求として使う。

`POST /api/runner/lease`

```json
{ "executorId": "home", "runnerId": "...", "max": 2, "waitMs": 20000, "fetchModes": ["http"] }
```

`queued` のjobがあれば `max` 件まで即座に返す。無ければ `waitMs`（上限20秒）までリクエストを保持し、その間にjobが投入されれば返す（long-poll）。leaseの呼び出しはheartbeatも兼ねる。応答:

```json
{ "jobs": [ {
  "jobId": "...", "leaseToken": "<32バイト乱数のbase64url>", "leaseExpiresAt": "...",
  "fetchMode": "http",
  "request": { "url": "https://example.com/feed.xml", "maxBytes": 5242880,
               "headers": { "user-agent": "...", "if-none-match": "\"abc\"" } }
} ] }
```

`fetchModes` に含まれないmodeのjobは渡さない。`headers` はGCP Executorと同じ許可リスト（`user-agent`、`accept`、`accept-language`、`referer`、`if-none-match`、`if-modified-since`）に限る。

1つのjobは一度だけleaseされる。lease応答がRunnerに届かなかった場合、そのjobはlease後の期限で `expired` になり、チェック側は `executor_unavailable` で次のFetcherへ進む。再leaseしないことで、同じURLを二重に取得しない。

`POST /api/runner/jobs/:jobId/result`

```json
{ "leaseToken": "...", "result": { "kind": "response", "status": 200, "url": "...",
  "contentType": "...", "headers": {}, "body": "<base64>", "truncated": false, "durationMs": 812 } }
```

`result` はGCP Executorの応答本文と同じ形とする。応答:

| 状況 | 応答 |
|---|---|
| 受理した | 200 `{"accepted": true}` |
| 同じ`leaseToken`で受理済みのjobへの再送 | 200 `{"accepted": true, "duplicate": true}` |
| `leaseToken` が一致しない | 409 `lease_mismatch` |
| jobが`expired` | 409 `lease_expired` |
| jobが無い（他executorのjob、削除済み） | 404 |
| 本文が上限（`maxBytes` のbase64換算＋64KiB）を超える | 413 |

`leaseToken` はCrawlerObjectにSHA-256だけを保存し、定数時間で比較する。Runnerは5xxとネットワークエラーのときだけ結果を再送し、409と404では再送しない。結果の受理は冪等なので、Runnerからの再送（少なくとも1回の配送）を安全に受けられる。

jobに個別の署名は付けない。Runnerは固定のbase URLへHTTPSで取りに行き、TLSでWorkerを、Accessのサービストークンで自分を認証する。jobの真正性はこの経路で担保され、ADR-0001の「署名付きジョブだけを実行する」はこの経路から受け取ったleaseを指すものとする。GCP Executorのような署名を足すと、鍵の配布とローテーションが増えるだけで防げる攻撃が増えない。

### 5. SSRFの責任分担

宅内のRunnerは、Cloudflare Workersの外で、家庭内LANに接続した状態で取得を行う。リダイレクト先や名前解決結果がLAN内を指すと、ルーターやNASなどへ到達してしまう。

- Worker: 投入前にSource URLの静的・動的検査（既存の `checkUrlForSsrf` と `resolveAndCheck`）を行う。Runnerが返した最終URLも `checkUrlForSsrf` で再検査し、不一致は `ssrf_blocked` とする。
- Runner: Workerの検査を信用せず、GCP Executorと同じ検査を自分でも行う（ADR-0021 §4）。http/httpsの80/443のみ、ユーザー情報付きURLを拒否、名前解決結果がprivate（RFC1918）、loopback、link-local、CGN、ULA、multicast、予約済みなら拒否、検証済みアドレスへ接続を固定、リダイレクトはホップごとに再検査する。
- 宅内固有の追加: 環境変数 `BLOCKED_CIDRS` で、宅内ネットワークの公開IPv4アドレスやISPから委譲されたIPv6プレフィックスを追加で拒否できるようにする。グローバルアドレスを持つLAN内機器はprivate判定に掛からないためである。既定ではIPv6での接続を行わない（`ALLOW_IPV6=false`）。

Runner側の検査で拒否した場合は `kind: "error"`、`failureClass: "ssrf_blocked"` を返す。`ssrf_blocked` は後続Fetcherへ進まない（ADR-0005）。

### 6. Runnerの実装と配布

- コードは `executors/home-runner/` に置く（Node.js、TypeScript）。GCP ExecutorのSSRF検査と取得処理は `executors/shared/` に切り出して両者で共有する。
- 設定は環境変数だけで行う。`UTSUROI_BASE_URL`、`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET`、`EXECUTOR_ID`、`CONCURRENCY`（既定2）、`HEALTH_PORT`（既定8080）、`BLOCKED_CIDRS`、`ALLOW_IPV6`。
- 動作: 空きスロット数を `max` にしてleaseをlong-pollし、受け取ったjobを並行実行して結果を返す。heartbeatは15秒ごとに送る。SIGTERMで新規leaseを止め、実行中のjobの結果を返してから終了する。401/403を受けたら設定誤りとして指数バックオフし、ログに残す。
- ヘルスチェック: `GET /healthz` は、直近60秒以内にWorkerとのleaseまたはheartbeatが成功していれば200、そうでなければ503を返す。イメージには `HEALTHCHECK` を入れる。
- イメージは GitHub Actions が `ghcr.io/ochanuco/utsuroi-runner` へ公開する。タグはコミットSHAと `latest`。

### 7. 観測

- 管理API `GET /api/executors` と `GET /api/executors/:id` を追加する。D1の `executors` に、CrawlerObjectから得た `online`（直近heartbeatが60秒以内のRunnerが1つ以上）、`lastHeartbeatAt`、Runnerごとのversion・concurrency・実行中job数、`queued` 件数、直近1時間の完了・期限切れ・拒否件数を合わせて返す。`home_runner` 以外のExecutorは `online` を返さない。
- Workerの構造化ログ: lease発行、結果受理（job id、fetcher id、kind、status、所要時間）、結果拒否（理由）、job期限切れ、`executor_unavailable` での即時失敗、Runnerのオンライン・オフラインの遷移。本文とトークンはログに出さない。
- Runnerのログ: 標準出力へJSONで、lease取得、結果送信、再送、取得失敗、認証エラーを出す。サービストークンは出さない。
- 試行履歴は既存の `GET /api/jobs/:id/attempts` で見る。`executor_job_id` からWorkerログのjobを辿れる。

### 8. 導入

- D1マイグレーションで、Executor `home`（kind `home_runner`、capabilities `{"fetch_modes":["http"]}`）とFetcher `home-http`（fetch mode `http`）を登録し、`check_attempts` に `executor_job_id` 列を足す。
- `wrangler.jsonc` にCrawlerObjectのbindingとDOマイグレーション（新しいタグで `new_sqlite_classes`）を足す。
- 段階的な有効化はADR-0005の仕組みそのもので行う。Fetcherを登録しても、SiteのAllowListへ明示的に追加するまでは使われない。`RUNNER_EXECUTORS` が空の間は `/api/runner/*` が403となり、`home-http` は `executor_unavailable` を即座に返す。

## Consequences

### Positive

- 宅内回線からの取得を、inboundの経路を開けずに追加できる。
- パイプラインと `runFetchSequence` を変えずに、レジストリへの登録だけで `home-http` を足せる。
- Runnerの停止は `executor_unavailable` として分類され、OrderListの次のFetcherへ進む。取得先hostのbackoffを巻き込まない。
- Runnerのトークンは `/api/runner/*` に閉じ込められ、漏洩時の影響が限られる。

### Negative

- 1回の取得につき最大50秒、チェックを実行しているMonitorObjectが待つ。Runnerが止まった直後は、heartbeatが古くなるかlease後の期限切れが起きるまでの間、期限いっぱい待つチェックが出る。
- 結果を永続化しないため、CrawlerObjectのリセット（デプロイ等）と重なった取得は `executor_unavailable` になる。
- `FailureClass` が1つ増え、Fetcher Policyの `proceedOn` 検証やHostObjectが新しい分類を知る必要がある。
- 長時間のBrowser取得を足すときは、Fetcher実装を継続方式へ移す必要がある。

## Guardrails

- RunnerはWorkerからleaseしたjobだけを実行し、自分でURLを決めて取得しない。
- 1つのjobは一度だけleaseする。期限切れのjobを再leaseしない。
- `leaseToken` が一致しない結果を受理しない。
- Runnerは宅内ネットワークへの取得を自身の検査で拒否する。Workerの検査を前提にしない。
- `executor_unavailable` はHostObjectの失敗連続回数に数えない。
- AllowList外のFetcherを暗黙に使わない（ADR-0005）。
