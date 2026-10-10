# ADR-0021: 外部Executorの配送方式（Home Runnerはpull型、GCP Executorはpush型）とFetcherレジストリ

- **Status**: Proposed
- **Date**: 2026-10-10

## Context

一部のSiteはCloudflareの送信元IPからのアクセスを403で拒否する。ADR-0001のとおり制御プレーン（Worker）と取得Executorは分離されており、ADR-0005のFetcher AllowList / OrderListで接続元をSite単位に選べる。取得経路としてCloudflare以外の実行基盤を足す必要がある。

実行基盤ごとに、Workerから到達できるかが異なる。

- Cloud Runは公開HTTPSエンドポイントを持ち、Workerから直接呼び出せる。
- 宅内のRunnerは外部から到達できない。宅内側からWorkerへ接続する必要がある。

## Decision

### 1. 配送方式を基盤の到達性で分ける

| Executor | 方式 | 概要 |
|---|---|---|
| GCP Executor（Cloud Run, `asia-northeast1`） | push型 | Workerが署名付きリクエストをPOSTし、応答を同期的に受け取る |
| Home Runner | pull型 | Runnerがjobをlease取得し、heartbeatで生存を報告し、結果を返す（実装は後続） |

どちらもWorkerからは「Fetcher idから`FetchOutcome`を得る非同期処理」として見える。

### 2. Fetcherレジストリ

`src/fetch/registry.ts`がFetcher idから実装へのレジストリを持つ。実装は`FetcherInvocation`（URL、User-Agent、条件付きリクエスト値、Env、SSRFガード）を受け取り`FetchOutcome`を返す関数である。

- `cf-http`は従来どおり`httpFetch`を呼ぶ。挙動は変えない。
- `gcp-http`はpush型の実装である。
- 未登録のidは`internal_error`を返す。実装が例外を投げた場合も`internal_error`に変換し、パイプラインへ例外を伝播させない。
- pull型の`home-*`は、jobをキューに積んでRunnerの結果を待つ関数として同じ形で登録できる。レジストリ側の変更は要らない。

Fetcher Policy（AllowList / OrderList / `proceedOn`）とCheckAttemptの記録は変更しない。

### 3. GCP Executorのpushプロトコル

Worker → Cloud Run: `POST`、本文はJSON `{url, maxBytes, headers?}`、`Authorization: Bearer <JWT>`。

JWTはEdDSA（Ed25519）で、Workerがwrangler secret `GCP_EXECUTOR_SIGNING_KEY`（PKCS8 PEM）で署名する。

| クレーム | 値 |
|---|---|
| `iss` | `utsuroi` |
| `aud` | `gcp-http` |
| `iat` / `exp` | 発行時刻 / 発行から30秒後（検証側は寿命60秒以内のみ許可） |
| `jti` | リクエストごとのUUID |
| `bh` | リクエスト本文のSHA-256のbase64url |

Cloud Runは環境変数`EXECUTOR_PUBLIC_KEY`（SPKI PEM）だけを持つ。検証は次のとおりで、不一致は401とする。

- `alg`はEdDSAのみ。
- `iss`、`aud`、`exp`（数秒のskew）、`bh`が本文と一致すること。
- 同一インスタンス内ではメモリ上の`jti`キャッシュで完全な再送を拒否する。`exp`内の別インスタンスへの再送は許容する（`bh`により別のリクエストへは転用できない）。

Cloud Runは`allUsers`にinvokerを開けているため、認可は上記のJWTだけに依存する。

応答はHTTP 200のJSONで、次のいずれか。

- `{kind: "response", status, url, contentType, headers, body(base64), truncated, durationMs}`: 取得先の応答（403や429も含む）。
- `{kind: "error", failureClass, message}`: 取得に至らなかった失敗。`failureClass`は`ssrf_blocked`、`timeout`、`network_error`、`too_large`のみ。

Workerは`kind: "response"`を、cf-httpと同じ分類器（`handleTerminalResponse`）に通して`FetchOutcome`にする。403→`http_403`（Bot challengeヘッダがあれば`captcha_challenge`）、429→`http_429`（`Retry-After`付き）、5xx→`http_5xx`、404/410→`not_found`。2xxと403で`truncated`の場合は`too_large`にする。

Executor自身の拒否はWorker側で次のとおり扱う。

- 401/403/400/413など（署名・設定の不整合）は`internal_error`。`NEVER_PROCEEDABLE`ではないが既定の`proceedOn`にも含まれないため、次のFetcherへは進まない。
- 502/503/504（Cloud Runの一時不可用）は`network_error`。
- `GCP_EXECUTOR_URL`が空、署名鍵が未設定、署名に失敗した場合は、通信せずに明確なメッセージの`internal_error`を返す。

### 4. GCP ExecutorのSSRF対策

公開エンドポイントのため、Executorは単独でSSRFを防ぐ。

- httpとhttpsのみ、ポートは80と443のみ。ユーザー情報付きURLは拒否する。
- ホスト名を解決し、解決結果のいずれかがprivate、loopback、link-local、CGN、multicast、予約済み、metadata（`169.254.169.254`、`metadata.google.internal`、`fd00::/8`を含む`fc00::/7`等）なら拒否する。IPv4埋め込み形式のIPv6（mapped、NAT64、6to4、Teredo）は丸ごと拒否する。
- 接続は検証済みのIPアドレスへ固定する（DNSを検査後に再解決しない）。TLSのSNIと証明書検証は元のホスト名で行う。これによりDNS rebindingを防ぐ。
- リダイレクトは手動で最大5回追跡し、ホップごとに上記を再実行する。
- 転送するリクエストヘッダは`user-agent`、`accept`、`accept-language`、`referer`、`if-none-match`、`if-modified-since`のみ。
- `maxBytes`はExecutor側でも上限を設け、展開後のサイズで数える。総処理時間にも上限を設ける。

### 5. Fetcher定義

マイグレーションで、Executor `gcp`（kind `cloud_run`）とFetcher `gcp-http`（fetch mode `http`、region `asia-northeast1`）を登録する。Siteが使うにはAllowListとOrderListへ明示的に追加する（ADR-0005）。

## Consequences

### Positive

- Cloudflareの送信元で拒否されるSiteを、AllowListで許可したSiteに限ってCloud Run経由で取得できる。
- 実行基盤の追加がレジストリへの登録で済む。
- 秘密鍵はWorkerだけが持つため、Cloud Run側の漏洩から署名を偽造されない。

### Negative

- Cloud Runの公開エンドポイントは、JWT検証とExecutor内のSSRF検査に安全性を依存する。
- 秘密鍵・公開鍵のローテーションは手作業になる。
- 別インスタンスへの`exp`内の再送は防げない（`bh`で転用は防ぐ）。

## Guardrails

- AllowList外のFetcherを暗黙に使わない（ADR-0005）。
- Executorは署名検証に失敗した要求を取得処理に渡さない。
- 秘密鍵をリポジトリに置かない。公開鍵だけを`executors/gcp-http/public-key.pem`に置く。
