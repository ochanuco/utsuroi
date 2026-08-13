# ADR-0017: robots origin の正規化と、一過性の robots.txt 取得不能の扱い

- **Status**: Accepted
- **Date**: 2026-08-13

## Context

本番の monitor 1件 (ひらつー / `https://www.hira2.jp`) が 2026-08-07T16:24Z から6日間
停止したままになっていた。調査で2つの独立した不具合が見つかった。

### 1. canonical_origin の表記ゆれで Override が照合されない

`runCheck` は `getRobotsMode(db, site.id, new URL(source.url).origin)` で Policy を引く。
`URL.origin` は `https://www.hira2.jp` (末尾スラッシュ無し) を返す。

一方 Override 登録 UI (`public/js/views/siteDetail.js`) は対象Origin の初期値を
`sites.primary_origin` から取っており、そこに `https://www.hira2.jp/` が入っていた。
API (`PUT /sites/:id/robots-overrides`) は `z.string().url()` で形式検査するだけで
正規化しないため、末尾スラッシュ付きのまま `robots_policies` に保存される。

`getRobotsPolicy` の照合は `WHERE canonical_origin = ?` の完全一致なので、この2つは
マッチせず `?? 'enforce'` にフォールバックする。**Override を設定しても無視される**。

### 2. 一過性の robots.txt 取得失敗で監視が恒久停止する

`checkRobots` は RFC 9309 に従い、robots.txt が 5xx / ネットワークエラーのときを
「取得不能 → disallow 扱い」で fail-closed にする (ADR-0008)。`runCheck` はこれを
明示的な `Disallow:` ルールと同一に扱い、`policyStopMonitor()` で
`status='blocked_by_robots' / next_run_at=NULL` の恒久停止にしていた。

停止は `resume()` の明示解除を要求する設計 (runCheck の status skip) なので、
**1回の一過性 503 で監視が永久に止まり、人が気付くまで復旧しない**。実際に今回は
直前のチェックまで `allowed` で、robots.txt は現在も 200 (`Disallow:` 空 = 全許可)
だった。ADR-0014 が fetch について同じ問題を「一過性の 5xx はリトライ対象」として
既に解いており、robots.txt 取得だけがその方針から外れていた。

なお `checkRobots` は取得不能の結果も D1 キャッシュに TTL 3600 秒で書き込んでいた。
これは復旧後も最大1時間 disallow を返し続けるうえ、「連続 N 回」を数えるときに
実際の再取得を伴わずカウントが進む原因にもなる。

## Decision

### origin 正規化

- `normalizeCanonicalOrigin(input)` (`src/robots/origin.ts`) を追加する。実体は
  `new URL(input).origin` で、URL として解釈できない入力は trim のみ行って返す
  (形式検査は API 層の zod の責務)。
- `upsertRobotsPolicy` / `getRobotsPolicy` / `getRobotsMode` の**すべて**でこれを通す。
  書き込み側だけの正規化では既存行を救えず、読み出し側だけでは新規行が汚れるため。
- API の監査ログ (`audit_events.subject` / `payload`) には正規化後の値を記録する。
  `robots_policies` の実データと監査ログの表記を一致させるため。
- 既存行はマイグレーション `0007` で正規化する。対象は「スラッシュがちょうど3つ」=
  `scheme://host[:port]/` 形の行のみに絞り、パスを含む値を誤って削らないようにする。
  UNIQUE 制約に衝突する行はスキップする (重複は運用判断)。
- `sites.primary_origin` 自体の正規化は**行わない**。他の用途への影響範囲が広く、
  Policy 照合は上記で表記ゆれに耐えるようになるため。

### 一過性の取得不能

- `decision.unavailable === true` (取得不能由来の disallow) と、`matchedRule` を伴う
  明示的な `Disallow:` を区別する。
- 取得不能由来は、同一 origin の `robots_evaluations` を直近から見て連続 unavailable が
  `ROBOTS_UNAVAILABLE_STOP_THRESHOLD` (= 3) 未満のあいだは Policy Stop せず、その
  チェックだけを `failed` で終える。`next_run_at` は通常どおり interval + jitter で
  進むので、監視は生き続ける。
- 連続3回に達したら従来どおり `policy_stopped` + `blocked_by_robots` にする。
  interval 1時間なら「3時間 robots.txt が落ちたまま」で停止する計算になる。
- 判定は `robots_evaluations` の既存行から数える (`countConsecutiveUnavailableRobotsEvaluations`)。
  監視状態にカウンタ列を足さない。評価は毎チェック1行記録済みで、
  `idx_robots_evaluations_origin (origin, checked_at)` がそのまま効く。
- 取得不能の結果は robots キャッシュに**書き込まない**。障害を TTL 分固定しないことで、
  「連続 N 回」が実際の再取得 N 回を意味するようにし、復旧の反映も次チェックで済む。
- CheckAttempt の `failure_class` は `blocked_by_robots` のまま据え置き、
  `error_message` を `robots_unavailable: <url> (consecutive n/3)` にして区別する。
  FailureClass の enum は SPEC §8 の proceedOn 判定に紐づくため、ここでは触らない。

## Consequences

- Override が UI 経由の表記ゆれで無視されることがなくなる。
- robots.txt の一過性障害で監視が落ちなくなる。恒久的にブロックされている場合は
  3チェック分 (interval 1時間なら約3時間) 遅れて従来どおり停止する。
- 取得不能中は毎チェック robots.txt を取りに行く。interval 単位なので負荷増は軽微。
- 停止までの猶予中は `check_jobs` が `failed` として積まれる。運用上は「robots.txt が
  取得できていない」シグナルとして読める。
- ホスト名の大文字小文字ゆれなど、マイグレーションの SQL では直せない表記ゆれが
  既存行に残る可能性はある。新規の書き込みはアプリ側の正規化で揃う。
- **未対応**: `policy_stopped` になったこと自体が通知されない。今回6日間気付けなかった
  主因はこれであり、別途対応する。
