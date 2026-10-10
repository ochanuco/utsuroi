# ADR-0020: 管理APIの認証を Cloudflare Access JWT 検証に置き換える

- **Status**: Proposed
- **Date**: 2026-10-10

## Context

管理API (`/api/*`) は共有の `ADMIN_TOKEN` による Bearer 認証だった。トークンは1つで、誰が操作したかを
区別できず、ブラウザ UI は localStorage に平文で保存していた。

Utsuroi はカスタムドメイン `utsuroi.chanu.co` で公開し、Cloudflare Access の背後に置く。Access は
認証済みリクエストに署名付き JWT を `Cf-Access-Jwt-Assertion` ヘッダで付けて転送する。ただし
Access は Worker の手前にあるだけで、workers.dev や preview URL が有効なままだったり、Access の
ポリシー設定を誤ったりすると、Worker は無認証で到達されうる。

## Decision

### 1. 全 `/api/*` で Access JWT を Worker 自身が検証する

`Cf-Access-Jwt-Assertion` ヘッダの JWT を毎リクエスト検証する。

- 署名は RS256 のみ受け付ける。`alg` が RS256 以外 (`none`, HS256 等) は拒否する。
- 検証鍵は `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` の JWKS から `kid` で引く。
  JWKS はメモリに TTL 付きでキャッシュし、未知の `kid` のときだけ再取得する。再取得には最短間隔を設け、
  偽の `kid` を送り続けても JWKS エンドポイントへ取得が殺到しない。JWKS が取得できなければ 503 とする。
- `iss` は `https://<ACCESS_TEAM_DOMAIN>` と完全一致、`aud` は `ACCESS_AUD` を含むこと。
  `exp` は必須で、`exp` / `nbf` は 60 秒の時計ずれを許容する。
- 検証は WebCrypto で行い、依存は追加しない。

ヘッダが無い、または JWT が不正なら 401 を返す。

### 2. 呼び出し元の識別

検証に通った JWT から caller id を決め、Hono の context 変数 `caller` に載せる。

| JWT の内容 | caller id |
|---|---|
| `email` claim がある（人間） | `user:<email>` |
| `common_name` claim がある（サービストークン） | `token:<name>`（`ACCESS_CALLERS` で Client ID から引く） |

`ACCESS_CALLERS` は Client ID から呼び出し元名への JSON オブジェクトで、vars に置く。
対応表に無い Client ID のサービストークンは 403 とする。JSON が不正な場合は空の対応表として扱う。

変更系リクエスト (POST / PATCH / PUT / DELETE) は caller id・メソッド・パスを構造化ログに出す。
専用の監査テーブルは作らない。

### 3. 未設定は fail closed

`ACCESS_AUD` が空、または `ACCESS_TEAM_DOMAIN` が不正な間は、全 `/api/*` リクエストを 503 で拒否し、
理由をエラーログに出す。設定漏れのまま公開しても認証が素通りしない。

### 4. workers.dev とプレビューを無効にする

`wrangler.jsonc` で `workers_dev: false` と `preview_urls: false` を指定し、カスタムドメイン
`utsuroi.chanu.co` だけを route にする。Access を経由しない到達経路を構成上なくす。

### 5. 管理 UI

UI のトークン入力と localStorage への保存は廃止する。ブラウザは Access の `CF_Authorization` Cookie で
認証済みで、UI からの API 呼び出しは同一オリジンなので追加の認証処理は要らない。

`ADMIN_TOKEN` は Env とコードから削除する。

## Consequences

- 操作者を人間ごと・サービストークンごとに区別でき、変更系操作の監査ログに残る。
- 認証の信頼境界が Access と Worker の二重になり、Access の設定ミスが即座に API の露出にならない。
- Access アプリケーションとポリシー、サービストークンは Worker の外で管理する。デプロイ前に `ACCESS_AUD` と
  `ACCESS_CALLERS` を実値にする必要があり、空のままだと API は使えない。
- JWKS の取得は Worker から Access のチームドメインへの外向き通信になる。キャッシュ期間中は取得に依存しない。
