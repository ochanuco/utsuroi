# ADR-0001: Cloudflareを制御プレーンとし取得Executorを分離する

- **Status**: Accepted
- **Date**: 2026-07-10

## Context

スケジュール、状態、差分、通知を一元管理しつつ、Cloudflareから取得できないサイトは宅内ホストやCloud Runで取得する必要がある。

## Decision

Cloudflareを制御プレーンとし、取得処理は交換可能なExecutorへ分離する。外部Runnerは独自スケジュールを持たず、署名付きジョブだけを実行する。

## Consequences

- 状態と実行環境を分離できる。
- 実行基盤を追加・停止しやすい。
- 外部Runner認証、heartbeat、lease管理が必要になる。
