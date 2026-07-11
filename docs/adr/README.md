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
| [0010](0010-detection-chain-and-source-promotion.md) | 検知チェーンとSource自動昇格 | Proposed |
