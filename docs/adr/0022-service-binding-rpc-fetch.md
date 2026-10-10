# ADR-0022: 他Workerからの取得依頼をService Binding RPCで受ける

- **Status**: Proposed
- **Date**: 2026-10-10

## Context

同一アカウントの他Workerが、UtsuroiのFetcher（ADR-0021）を使ってページを取得したい。管理API（`/api/*`）はCloudflare AccessのJWT検証で守られている（ADR-0020）が、Service Bindingの呼び出しはAccessを経由せず、JWTを持たない。管理APIの認証を緩めずに、別の入口を用意する必要がある。

## Decision

### 1. RPC専用のEntrypointを公開する

`src/index.ts`から`FetchEntrypoint`（`WorkerEntrypoint`）をexportし、`fetchPage(req)`を公開する。公開fetchハンドラと`/api/*`の認証には手を入れない。Service BindingはWorker間の内部経路であり、公開ホスト名からは到達できない。

```ts
interface FetchPageRequest { url: string; maxBytes?: number; headers?: Record<string, string> }
interface FetchPageResult {
  ok: boolean; status: number; statusText: string; url: string; contentType: string | null;
  truncated: boolean; bytes: number; html: string; fetcherId: string | null; failureClass?: string;
}
```

### 2. 呼び出し元はbindingのpropsで識別する

呼び出し元Workerのbinding定義にある`props.caller`を`this.ctx.props.caller`で読む。propsはデプロイ設定で決まり、呼び出し側のコードからは書き換えられない。`caller`が無い、文字列でない、`RPC_CALLERS`に登録が無いときはErrorを投げ（RPCはrejectされる）、構造化ログに理由を残す。

### 3. 呼び出し元ごとの許可をsecretに置く

wrangler secret `RPC_CALLERS`にJSONで持つ。公開リポジトリに実ホスト名を置かないため、`wrangler.jsonc`には書かない。

```json
{ "<caller>": { "allowedHosts": ["www.example.com"], "fetchers": ["cf-http", "gcp-http"] } }
```

JSONが不正、または形が違うエントリは無いものとして扱い（全拒否）、不正な値につき1回だけエラーログを出す。

### 4. 取得前後の検査

- URLはhttp(s)で、ホストが`allowedHosts`のいずれかと大文字小文字を区別せず完全一致し、かつ既存のSSRF検査（`checkUrlForSsrf`）を通ること。満たさなければFetcherを呼ばず`failureClass: 'ssrf_blocked'`（`status: 0`、`fetcherId: null`）を返す。
- Fetcherに渡すURLガードにも同じ検査を使うため、リダイレクトの各ホップが`allowedHosts`の外に出ると拒否される。返ってきた最終URLのホストも再検査する。
- 転送するrequest headerは`user-agent` / `accept` / `accept-language` / `referer`のみ。他は無視する。`headers`は`cf-http`にだけ反映される。
- `maxBytes`の既定は2 MiB、上限は5 MiB。超過分は切り捨てて`truncated: true`とする。

### 5. Fetcherの試行順

`fetchers`の順にレジストリ経由で試す。次へ進むのは、`http_5xx` / `network_error` / `timeout`、`http_403`、およびHTTP応答を得られなかった失敗（Fetcher未設定の`internal_error`等）のとき。`not_found` / `auth_required` / `too_large` / `captcha_challenge` / `http_429`などHTTP応答を伴う他の失敗は、そこで確定して返す。すべて失敗した場合は最後の失敗分類と、得られていれば最後のHTTPステータスを返す。

### 6. ログ

1呼び出しにつき`{event, caller, host, fetcherId, status, failureClass}`を1行出す。URLのパス・クエリ・本文は出さない。

## Consequences

- 管理APIの認証境界は変わらず、RPC面は「どのWorkerが、どのホストを、どのFetcherで」取得できるかをsecretで絞る。
- 呼び出し元の追加・変更は`RPC_CALLERS`の更新と、呼び出し元Workerのbinding定義（`props.caller`）の両方が要る。
- `gcp-http`は追加header（`accept`等）を転送しない。`user-agent`はFetcherの引数として渡る。
- Fetcherが返すのは最終的なレスポンスのみで、リダイレクト中継ホップはURLガードによる検査で止める。
