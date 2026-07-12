# Utsuroi Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-cloudflare-control-plane.md) | Cloudflareを制御プレーンとし取得Executorを分離する | Accepted |
| [0002](0002-durable-object-boundaries.md) | Durable ObjectsをMonitor・Host・Crawler境界に分割する | Accepted |
| [0003](0003-scheduling-and-execution.md) | Monitor Alarmとreconciliationでスケジュールする | Proposed |
| [0004](0004-source-adapters.md) | Page・RSS/Atom・SitemapをSource Adapterとして統合する | Accepted |
| [0005](0005-fetcher-allowlist-and-orderlist.md) | Site単位のFetcher AllowListとOrderListを採用する | Accepted |
| [0006](0006-snapshot-storage-and-diff.md) | 本文はR2、索引はD1、差分は決定論的処理を優先する | Accepted |
| [0007](0007-discord-notification.md) | Discord WebhookをDestinationとしてQueue配送する | Accepted |
| [0008](0008-robots-txt-compliance.md) | robots.txtを遵守し禁止時はMonitorをPolicy Stopする | Accepted |
| [0009](0009-explicit-robots-override.md) | Siteとorigin単位の明示的robots.txt Overrideを許可する | Accepted |
| [0010](0010-detection-chain-and-source-promotion.md) | Sitemap探索（lastmodベース差分探索、探索・監視・配信の分離） | Proposed |
| [0011](0011-page-item-extraction.md) | pageアイテム抽出モード（CSSセレクタによる新着検知、Processor抽象の第2具体化） | Proposed |
| [0012](0012-destination-archive.md) | Destinationのアーカイブ（soft delete、配送履歴を保ったままwebhookを破棄） | Proposed |
| [0013](0013-extract-structured-fields.md) | アイテム抽出モードの構造化フィールド抽出（price/所在地等をdiff_previewに配線、PATCH /api/sources/:id） | Proposed |
| [0014](0014-transient-fetch-retry.md) | 一過性フェッチ失敗のチェック内リトライ（http_5xx/network_errorを250ms×nバックオフで計3試行） | Proposed |
