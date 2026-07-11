# ADR-0012: Destination のアーカイブ (soft delete)

- **Status**: Proposed
- **Date**: 2026-07-12

## Context

deliveries は配送履歴 (監査記録) として意図的に残す設計であり、`deliveries.destination_id` は
`destinations(id)` への FOREIGN KEY を持つ (ADR-0007, migrations/0001)。その結果、一度でも
配送実績のある Destination は `DELETE /api/destinations/:id` が FK 制約違反となり、API は
409 `destination_has_delivery_history` を返す。

この設計には2つの問題がある。

1. **行き止まり UX**: 「配送履歴が残っている場合は削除できません」と返すだけで、履歴を保持
   したまま Destination を片付ける代替手段が存在しない。使用済み Destination は永久に一覧に
   残り続ける。
2. **secret の保持**: destinations 行には暗号化済みとはいえ webhook URL (Discord への書き込み
   credential) が残り続ける。「この webhook はもう使わないので破棄したい」という削除の最も
   正当な動機を満たせない。

守りたい不変条件は「配送履歴の監査可能性」であって「destinations 行の不滅性」ではない。

## Decision

Destination に **アーカイブ (soft delete)** を導入する。

### 1. スキーマ

migration で `destinations.archived_at TEXT` (NULL 可) を追加する。`archived_at IS NOT NULL`
がアーカイブ済みを表し、タイムスタンプがそのまま監査情報になる。既存の `enabled` カラムは
現状ファンアウトで参照されておらず、意味論の重複を避けるため本ADRでは触れない。

### 2. アーカイブ操作 (`POST /api/destinations/:id/archive`)

- `archived_at` に現在時刻を設定し、**`webhook_url` を空文字にする** (暗号文ごと破棄)。
  復元は不可。再利用したい場合は新しい Destination を作成する。
- 従属 subscriptions を同時に削除する (delete と同じ扱い。購読は再作成可能な設定であり
  履歴ではない)。
- 監査イベント `destination.archive` を記録する。
- 冪等: アーカイブ済みに対する再実行はエラーにせず現状を返す。

### 3. アーカイブ済み Destination の扱い

- **ファンアウト除外**: `listMatchingSubscriptions` は destinations を JOIN し
  `archived_at IS NULL` を条件に加える (subscriptions 削除と二重の防御)。
- **配送ワーカー防御**: `getPendingDelivery` はアーカイブ済み Destination の delivery を
  claim した場合、復号を試みず delivery を `dead` (last_error: destination archived) にして
  null を返す (アーカイブ前に enqueue 済みのメッセージ対策)。
- **購読作成拒否**: アーカイブ済み `destination_id` への `POST /api/subscriptions` は
  400 `destination_archived`。
- **一覧**: `GET /api/destinations` はアーカイブ済みも返す (レスポンスに `archived_at` を
  含め、マスク済み webhook 表示は null)。UI はバッジ表示し、購読作成の選択肢からは除外する。
- **DELETE との関係**: `DELETE /api/destinations/:id` は従来どおり (配送履歴が無ければ物理
  削除可)。409 のメッセージにアーカイブという代替手段を案内する。

## Alternatives

- **`ON DELETE SET NULL` + 配送先名の非正規化**: deliveries に destination_name を持たせて
  物理削除を許す。履歴の意味は保てるが、migration が重く (既存行の埋め戻し)、「誰に配送した
  か」の追跡が弱くなる。
- **カスケード削除 (履歴ごと削除、確認付き)**: 監査記録を落とす選択肢をユーザーに渡すことに
  なり、deliveries を履歴として残す ADR-0007 の意図と矛盾する。

## Consequences

- 使用済み Destination を UI から片付けられるようになり、webhook credential も破棄できる。
- アーカイブは不可逆 (webhook 暗号文を破棄するため)。「一時停止」用途には向かない。将来
  必要になれば `enabled` トグルをファンアウトで尊重する変更を別途行う。
- deliveries と FK・監査履歴は無傷のまま保たれる。
