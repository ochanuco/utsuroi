# ADR-0003: Monitor Alarmとreconciliationでスケジュールする

- **Status**: Proposed
- **Date**: 2026-07-10

## Context

CronだけではMonitorごとの間隔、ジッター、pause/resume、未完了ジョブの直列化を表現しづらい。一方、Alarmだけでは消失やデプロイ障害への復旧経路が弱い。

## Decision

MonitorObject Alarmを主スケジューラとし、Cron reconciliationを復旧経路として併用する。永続的な冪等キーで重複起動を防止する。

## Consequences

- Monitorごとの柔軟なスケジュールが可能になる。
- Alarm overdueの検出と再設定が必要になる。
