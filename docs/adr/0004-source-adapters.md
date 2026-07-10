# ADR-0004: Page・RSS/Atom・SitemapをSource Adapterとして統合する

- **Status**: Accepted
- **Date**: 2026-07-10

## Context

Page差分、Feed新着、Sitemap URL発見は入力形式が異なるが、取得、状態保存、イベント生成、通知の流れは共通する。

## Decision

Page、RSS、Atom、Sitemap、Sitemap IndexをSource Adapterとして実装し、Monitor、Target、Change Eventへ接続する。

## Consequences

- 共通の実行・履歴・通知基盤を利用できる。
- Sourceごとの安定キーと更新判定規則が必要になる。
