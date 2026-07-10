# ADR-0005: Site単位のFetcher AllowListとOrderListを採用する

- **Status**: Accepted
- **Date**: 2026-07-10
- **Updated**: 2026-07-10

## Context

対象サイトは、Cloudflare、Google Cloud、宅内回線など接続元によって取得可否が異なる。単一のグローバルな代替順では、Siteが利用を許可していない実行基盤が障害時に選択される可能性がある。

## Decision

Siteごとに以下を設定する。

- **AllowList**: 利用を許可するFetcher集合
- **OrderList**: AllowList内を自動試行する順序

FetcherはExecutor、Fetch mode、地域・ネットワークProfileを組み合わせた論理取得経路とする。

不変条件:

1. OrderListの全FetcherがAllowListに含まれる。
2. AllowListの全FetcherがOrderListに1回だけ含まれる。
3. AllowListは空にできない。
4. 実行直前にもAllowListを再検証する。

OrderList内で次候補へ進むのは、現在のFetcherに定義された失敗分類へ一致する場合だけとする。robots.txt禁止、SSRF違反、404/410、認証要求等では進まない。

成功率に基づく順序変更の推奨は将来提供してよいが、AllowListへの自動追加やOrderListの自動変更は行わない。

## Consequences

### Positive

- Site固有の接続元制約を明示できる。
- 障害時にも未許可Fetcherを使用しない。
- 実際の試行順が再現可能になる。

### Negative

- AllowListとOrderListの整合性検証が必要になる。
- 新Fetcherは明示許可されるまで既存Siteで使われない。

## Guardrails

- グローバルな暗黙の代替経路を持たない。
- AllowList外を補完・推測・自動追加しない。
- Attempt数とコストに上限を持つ。
- 403/429時に全Fetcherを連打しない。
- HostObjectのbackoffはFetcherを跨いで共有する。
