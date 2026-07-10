# ADR-0008: robots.txtを遵守し取得禁止時はMonitorをPolicy Stopする

- **Status**: Accepted
- **Date**: 2026-07-10

## Context

Utsuroiは定期取得する自動クライアントである。robots.txtによる禁止時に取得経路を切り替えると、サイト運営者の意思を実行基盤の違いで回避する設計になる。

## Decision

RFC 9309に基づいてrobots.txtを遵守する。

- Source URLと発見したTarget URLを取得前に評価する。
- Utsuroi専用User-Agent tokenのルールを使用する。
- 結果をorigin単位で保存する。
- Sitemap宣言を包括的許可とは解釈しない。

禁止時:

1. URLを取得しない。
2. `blocked_by_robots`を永続化する。
3. robots.txt URL、確認日時、User-Agent group、matched ruleを保存する。
4. 後続Fetcherへ進まない。
5. Monitorを`blocked_by_robots`へ遷移させる。
6. 次回Alarmを取り消す。
7. UIに停止理由を表示する。

`blocked_by_robots`はネットワーク障害ではなくPolicy Stopとして扱う。

## Consequences

- 不要な再試行と経路切替を防止できる。
- robots.txtの取得失敗・キャッシュ・再評価規則が必要になる。
