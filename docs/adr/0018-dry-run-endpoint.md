# ADR-0018: DryRun エンドポイント (URL単発の下見)

- **Status**: Accepted
- **Date**: 2026-08-14

## Context

Site / Source / Monitor を登録する前に「このURLは監視できそうか」を確かめる手段が無かった。
実際に登録してチェックが1周するまで、robots.txt がどう判定されるのか、ページが取れるのか、
タイトルが取れるのかが分からない。ADR-0017 で扱った robots 周りの調査でも、判定を確認する
だけのために本番の monitor 状態を読むしかなかった。

必要なのは「URLを1本入れたら、robots.txt の判定と `<title>` が返る」だけの軽い下見であって、
Site/Source を作らせたり監視状態を触ったりするものではない。

## Decision

`POST /api/dry-run` を追加する。リクエストは `{ url }` のみ。Site にも Monitor にも紐づかない。

### 副作用を持たない

DB へは一切書き込まない。具体的に、以下をすべて作らない:

- `robots_cache` (checkRobots に cache を渡さない)
- `robots_evaluations`
- `check_jobs` / `check_attempts` / `snapshots` / `targets`
- `audit_events`

robots キャッシュを使わないのは副作用を避けるためだけでなく、**いま現在の robots.txt の状態を
返すため**でもある。キャッシュ (TTL 3600秒) を経由すると最大1時間前の判定が返り、下見の
道具として意味をなさない。

### robots.txt は「判定して報告する」だけで、実行を止めない

robots が `disallowed` でも対象ページの取得を続行し、判定は結果に載せて返す。

監視ループ (ADR-0008) は robots を強制する。DryRun がそこから外れる理由は、**人が明示的に
1回だけ叩く操作**であり、繰り返し・自動・無人でアクセスする監視とは性質が違うため。
ブラウザでURLを開いて確認するのと同じ粒度の行為として扱う。

代わりに、判定は必ず結果に出す。UI では以下を明示する:

- `disallowed` のとき: 「監視を登録しても実行時に停止する。続けるには robots Override が必要」
- robots.txt 取得不能のとき: 「この状態が続くと連続3回で監視が停止する」(ADR-0017)

つまり DryRun は「robots を無視して取りに行く道具」ではなく、**「監視に載せたらどうなるかを
事前に見せる道具」**である。

### SSRF は従来どおり強制する

robots がポリシーであるのに対し、SSRF はセキュリティ境界なので DryRun でも例外にしない。
静的検査 (`checkUrlForSsrf`) と動的検査 (`resolveAndCheck`) の両方を通し、拒否時は 400
(`ssrf_blocked`) で返してフェッチ自体を行わない。リダイレクト追跡中の再検査
(`httpFetch` の `urlGuard`) も従来どおり有効。

`zod` の `.url()` は `javascript:` や `file:` も通すため、スキームは http/https に限定する
(`unsupported_scheme`)。

### 取得とタイトル抽出

手順は `enrichTitle.ts` の `fetchTitleForUrl` と同じ並び (SSRF → robots → フェッチ →
デコード → title抽出) を踏襲し、`httpFetch` + `decodeHtmlBestEffort` + `extractHtmlTitle`
を再利用する。Fetcher Policy (`runFetchSequence`) は使わない — Site に紐づかないので
policy が引けず、DryRun に多段フォールバックは要らないため。

ページ取得の失敗 (404 / 5xx / 非HTML / title無し) はエラーにせず 200 で返し、
`fetch.ok` と `title_skip_reason` に理由を載せる。下見の結果として「取れなかったこと」自体が
知りたい情報だから。

### UI

`#/dry-run` に専用ページを置き、ナビに追加する。URL入力欄と、robots判定 / ページ取得 /
タイトルの3セクションを表示するだけ。Source 登録フォームには組み込まない (単体で使えることを
優先し、フォームの複雑化を避ける)。

## Consequences

- Source 登録前に robots とタイトルを確認できる。ADR-0017 のような調査でも最初の一手になる。
- DryRun 経由なら robots で禁止されたページも Worker が取得しうる。人が明示的に1回叩く経路
  のみで、監視ループの挙動は変わらない。認証は既存の Bearer トークンで、管理者だけが叩ける。
- `CreateAppOptions` に `fetchImpl` を追加した (テストで実ネットワークを使わないため)。
  DryRun 以外のルートはこれを使っていない。
- レート制限は設けていない。管理者しか叩けず手動操作である前提。将来この前提が崩れるなら
  HostObject 経由のレート制限を検討する。
