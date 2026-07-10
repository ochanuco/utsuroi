# ADR-0002: Durable ObjectsをMonitor・Host・Crawler境界に分割する

- **Status**: Accepted
- **Date**: 2026-07-10

## Context

Monitorの直列化、同一hostへのアクセス制御、外部Runnerのcapacity管理は、それぞれ異なる一意性とライフサイクルを持つ。

## Decision

- `MonitorObject`: monitor_id単位
- `HostObject`: canonical origin単位
- `CrawlerObject`: executor_id単位

長期本文・履歴はD1/R2へ保存し、Durable Object storageへ蓄積しない。

## Consequences

- 排他境界が明確になる。
- 同一hostの制御をMonitor間で共有できる。
- オブジェクト間連携と障害時復旧が必要になる。
