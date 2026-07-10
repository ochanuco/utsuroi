# Utsuroi 仕様書

- **プロジェクト名**: Utsuroi — website change detection
- **文書状態**: Draft v0.2
- **更新日**: 2026-07-10
- **対象フェーズ**: MVP〜初期運用

## 1. 概要

Utsuroiは、Webページ、RSS/Atom、Sitemapを継続監視し、変更や新着を検出してDiscordへ通知する個人向けWeb監視システムである。

Cloudflareを制御プレーンとして利用し、取得処理はCloudflare、宅内ホスト、Google Cloud Runなど複数の実行基盤へルーティングできる。Siteごとに利用可能なFetcherと自動試行順を明示する。

## 2. 目的

1. 静的・動的Webページの変更を安定して検知する。
2. RSS/AtomとSitemapから新着URL・更新URLを検知する。
3. Site単位で取得方式・実行基盤・試行順を制御する。
4. 同一hostへのアクセスを一元制御し、過剰アクセスを防ぐ。
5. 取得失敗を分類し、許可されたFetcher内でのみ次候補を試す。
6. 変更履歴、取得経路、差分、停止理由を確認できるようにする。
7. 複数のDiscordサーバー・チャンネルへ通知する。
8. 将来の意味的差分判定を追加できるデータ構造にする。

## 3. 非目標

MVPでは以下を対象外とする。

- 汎用タスクスケジューラ、任意コマンド実行、DAGワークフロー
- Gmail、GitHub等のWeb以外のSource
- CAPTCHA、ログイン制限、アクセス制御の回避
- 汎用的な大規模クローラー
- 検索エンジン向け全文インデックス
- 複雑な認証操作を伴うサイト監視
- LLMのみを根拠にした変更判定
- 複数ユーザー、課金、組織管理
- Discord以外の通知先

将来構想は`ROADMAP.md`で管理し、本仕様書の実装範囲には含めない。

## 4. 基本原則

### 4.1 制御と実行の分離

Cloudflareは設定、スケジュール、状態、差分、通知を管理する。取得処理を実行するコンポーネントは交換可能なExecutorとして扱う。

### 4.2 Durable Objectsに長期履歴を蓄積しない

Durable Objectsは排他制御、レート制御、短期状態、Alarm、実行基盤のキャパシティ管理に使用する。本文と長期履歴はD1/R2へ保存する。

### 4.3 決定論的差分を優先する

ハッシュ、正規化DOM、抽出テキストによる差分判定を先に行い、意味的判定は変更候補への後段処理とする。

### 4.4 少なくとも1回の配送を前提にする

ジョブと通知は重複する可能性を前提とし、永続的な冪等キーで二重実行・二重通知を防止する。

### 4.5 許可境界と試行順を分離する

SiteごとにFetcherの`AllowList`と`OrderList`を持つ。AllowList外のFetcherは、障害時・手動実行時を含めて選択しない。

### 4.6 robots.txtを既定で遵守する

RFC 9309に基づいてrobots.txtを評価する。禁止時は後続Fetcherへ進まず、理由を記録してMonitorを停止する。認証済み管理者はSiteとorigin単位で明示Overrideできる。

## 5. 用語

| 用語 | 定義 |
|---|---|
| Site | 同じ運用ポリシーを共有する監視対象。通常は1つのoriginまたは関連origin群 |
| Source | 更新情報の入力元。Page、RSS/Atom、Sitemap |
| Monitor | Sourceに対する監視設定と実行状態 |
| Target | 実際に取得・比較するURL |
| Fetcher | Executor、Fetch mode、地域・ネットワークProfileを組み合わせた論理取得経路 |
| Fetcher Policy | SiteごとのAllowListとOrderList |
| AllowList | Siteで利用を許可するFetcher集合 |
| OrderList | AllowList内のFetcherを自動試行する順序 |
| Executor | HTTPまたはBrowserで取得する実行基盤 |
| Snapshot | 取得時点のレスポンスと正規化済み内容 |
| Change Event | 変更または新着を表す不変イベント |
| Destination | Discord Webhook等の通知先 |
| Subscription | EventをDestinationへ配送する規則 |
| Policy Stop | robots.txt等により自動再試行を行わず停止した状態 |

## 6. 対応Source

- `page`
- `rss`
- `atom`
- `sitemap`
- `sitemap-index`

## 7. 取得方式

### 7.1 HTTP Fetch

- GETを基本とする。
- ETag、Last-Modifiedによる条件付きリクエストに対応する。
- リダイレクト、サイズ、接続時間、応答時間、総処理時間に上限を設ける。
- Content-Typeを検証する。
- User-Agent、Accept-Language等をSiteまたはProfile単位で設定できる。

### 7.2 Browser Fetch

- Playwright互換ブラウザを使用する。
- `waitUntil`、追加待機、selector待機を設定できる。
- Cookie・StorageはSite単位の明示設定時のみ利用する。
- 画面操作シナリオはMVP対象外とする。
- 描画後HTML、最終URL、主要レスポンス情報を返す。

## 8. Fetcher Policy

Siteごとに以下を設定する。

```yaml
allow_list:
  - cf-http-apac
  - home-browser
order_list:
  - cf-http-apac
  - home-browser
```

不変条件:

1. OrderListの全FetcherがAllowListに含まれる。
2. AllowListの全FetcherがOrderListに1回だけ含まれる。
3. AllowListは空にできない。
4. 実行直前にもAllowListを再検証する。

後続Fetcherへ進むのは、現在のFetcherの失敗分類が許可条件に一致する場合だけとする。

原則として後続へ進まない例:

- `blocked_by_robots`
- SSRF違反
- 404、410
- 明示的な認証要求
- 最大サイズ超過
- CAPTCHAまたはBot challenge

## 9. robots.txt

### 9.1 既定動作

- Page、RSS/Atom、Sitemap、Sitemap IndexのSource URLを取得前に評価する。
- FeedやSitemapから発見したTarget URLも個別に評価する。
- Utsuroi専用User-Agent tokenに適用されるルールを使用する。
- 評価結果をorigin単位で保存する。

禁止時:

1. 対象URLを取得しない。
2. Check Attemptを`blocked_by_robots`として保存する。
3. robots.txt URL、確認日時、User-Agent group、matched ruleを保存する。
4. OrderListの後続Fetcherへ進まない。
5. Monitorを`blocked_by_robots`へ遷移させる。
6. 次回Alarmを取り消す。
7. UIへ停止理由と判定根拠を表示する。

### 9.2 明示Override

認証済み管理者は`site_id + canonical_origin`単位で`ignore`を設定できる。

- グローバルOverrideは提供しない。
- robots.txtの取得・解析は継続する。
- 本来禁止の場合は`robots_would_block=true`として記録する。
- 理由入力と明示確認を必須とする。
- 有効化・解除を監査ログへ追記する。
- Overrideはrobots.txtのPolicy Stopだけを上書きし、Fetcher AllowList、SSRF、認証、rate limit等は上書きしない。

## 10. スケジューリング

- Monitorごとの次回実行時刻を永続化する。
- MonitorObject Alarmを主スケジューラとする。
- 同じMonitorの未完了ジョブがある場合は重複起動しない。
- 実行時刻へ設定可能なジッターを加える。
- Cron reconciliationで期限超過Monitorを検出し、Alarm消失等から復旧する。
- 手動実行をサポートする。

## 11. Durable Object境界

### MonitorObject

- 次回Alarm
- 実行中ジョブの冪等制御
- 直近成功・失敗の短期状態
- pause/resume
- 手動実行の直列化

### HostObject

キーはcanonical originとする。

- 最小アクセス間隔
- 最大同時実行数
- lease
- Retry-After
- backoff
- circuit breaker
- Fetcherを跨ぐhost単位統計

### CrawlerObject

キーは外部Runnerの論理`executor_id`とする。

- heartbeat
- capacity
- lease
- 対応fetch mode
- version
- maintenance状態

Runnerは自律スケジュールを持たず、Cloudflare側から発行された署名付きジョブのみ実行する。

## 12. 正規化と差分

初期正規化:

- UTF-8統一
- script、style、noscript、コメントの設定可能な除去
- 属性順序、空白、改行の正規化
- 絶対URL化
- tracking query除去
- ignore selector除去
- include selector抽出
- nonce、timestamp等の動的属性除外

判定レベル:

1. HTTPメタデータ
2. raw body hash
3. normalized DOM hash
4. extracted text hash
5. 構造・テキスト差分
6. MVP後: semantic classification

## 13. 永続化

- raw/normalized bodyはR2へ保存する。
- 同一内容はcontent-addressed keyで重複保存しない。
- D1には索引とメタデータを保存する。
- Durable Object storageには長期本文を保存しない。

主要テーブル:

- `sites`
- `sources`
- `monitors`
- `fetchers`
- `fetcher_policies`
- `fetcher_policy_entries`
- `executors`
- `targets`
- `check_jobs`
- `check_attempts`
- `snapshots`
- `changes`
- `destinations`
- `subscriptions`
- `deliveries`
- `robots_policies`
- `robots_evaluations`
- `audit_events`

## 14. Discord通知

- 複数WebhookをDestinationとして登録できる。
- Site、Monitor、タグ、Event種別ごとにSubscriptionを設定できる。
- Change EventとDestinationの組を冪等キーとする。
- Queueを介して配送する。
- 429ではRetry-Afterを尊重する。
- Webhook URLは平文表示しない。

## 15. セキュリティ

- URL登録時と接続直前にSSRF検査を行う。
- loopback、link-local、private、metadata endpointを既定拒否する。
- DNS rebindingを考慮して接続時にも解決結果を検証する。
- 外部Runnerとの通信はmTLSまたは短寿命署名トークンを使用する。
- Webhook URL、Cookie等はSecretsまたは暗号化済み参照として管理する。
- CAPTCHAやアクセス制御を回避する機能は実装しない。

## 16. MVP範囲

### 必須

- Page、RSS/Atom、Sitemap監視
- HTTP Fetch
- Cloudflare Browser
- Home Runner
- Site単位Fetcher AllowList / OrderList
- HostObjectによるrate limit
- MonitorObject Alarm
- D1メタデータ、R2本文
- DOM/Text差分
- robots.txt遵守、Policy Stop、明示Override
- 複数Discord Webhook
- Check履歴、差分、停止理由表示

### MVP後

- Cloud Run Runner
- 地域別Cloudflare Executor
- Cookieを伴うBrowser Session
- semantic change classification
- 自動selector提案
- 通知要約
- Fetcher順序の推奨
- 高度なWorkflows/Queue運用UI

## 17. 受け入れ条件

1. 100件のMonitorを異なる間隔で24時間動かし、期限超過が自動復旧される。
2. 同一hostの設定上限を超えた並列取得が発生しない。
3. AllowList内のFetcherだけが使用される。
4. OrderListに従い、許可された失敗分類でのみ次Fetcherへ進む。
5. robots.txt禁止時に取得・後続試行を行わず、Monitorが停止する。
6. Override有効化に理由・確認・監査記録が必要である。
7. 同一Check Jobが重複してもSnapshot、Change、通知が重複しない。
8. RSSの同一entryを重複通知しない。
9. Sitemap Index配下の新規URLを検出できる。
10. 変更前後の本文と差分をUIで確認できる。

## 18. 未決事項

- WorkflowsをMVP必須とするか。
- QueueをCheck実行にも使用するか。
- 外部Runnerのjob deliveryをpull型にするかpush型にするか。
- Browser SessionをHostObjectとCrawlerObjectのどちらへ関連付けるか。
- semantic判定モデルとコスト上限。
