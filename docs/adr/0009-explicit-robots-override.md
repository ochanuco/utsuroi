# ADR-0009: Siteとorigin単位の明示的なrobots.txt Overrideを許可する

- **Status**: Accepted
- **Date**: 2026-07-10
- **Amends**: [ADR-0008](0008-robots-txt-compliance.md)

## Context

Site所有者自身の監視やrobots.txtの誤設定など、禁止を理解したうえで監視を継続したい場合がある。無条件またはグローバルな無視は、意図しない対象まで影響する。

## Decision

認証済み管理者が`site_id + canonical_origin`単位でOverrideを有効化できるようにする。

- `enforce`: 禁止時にPolicy Stopする既定値
- `ignore`: 禁止判定を記録しつつ取得を続行する

`ignore`でもrobots.txtの取得・解析を継続し、禁止時は`robots_would_block=true`を記録する。

有効化時は対象、robots.txt URL、matched rule、影響、明示確認、空欄不可の理由入力を表示する。Override中はUIへ警告を常時表示する。

監査イベント:

- Override ID
- Site ID、origin
- 有効化・解除
- actor
- 理由
- 発生日時
- robots.txt hash
- User-Agent group
- matched rule
- 影響Monitor

Overrideはrobots.txtによるPolicy Stopだけを上書きする。Fetcher AllowList、SSRF、認証、CAPTCHA、rate limit、backoff等は変更しない。

## Consequences

- 例外を限定的かつ監査可能に扱える。
- UI、権限、監査ログ、競合制御が必要になる。
