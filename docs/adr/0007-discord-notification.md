# ADR-0007: Discord WebhookをDestinationとしてQueue配送する

- **Status**: Accepted
- **Date**: 2026-07-10

## Context

複数サーバー・チャンネルへ通知し、429や一時障害へ対応する必要がある。変更検知処理と通知失敗を分離したい。

## Decision

Discord WebhookをDestinationとして登録し、Subscriptionに基づいてQueue経由で配送する。`change_id + destination_id`を冪等キーとする。

## Consequences

- 変更検知と通知配送を分離できる。
- 再試行、dead-letter相当の状態、Webhook Secret管理が必要になる。
