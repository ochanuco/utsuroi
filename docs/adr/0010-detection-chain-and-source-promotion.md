# ADR-0010: Sitemap階層の探索（探索・監視・配信の分離）

- **Status**: Proposed
- **Date**: 2026-07-11

## Context

MVPの監視は単発である。1つのSourceが1つの入力を取得し、変化を検知して配信する。

sitemap-indexを監視する際、現行実装は子Sitemapをその場で全展開し、配下の実URLをすべてTarget化していた。これは初回に数千件のChangeを生成し、Workersの実行制限を超えてジョブが完走しない障害を起こした（本番でsitemap-index監視が6,021 URLを生成しジョブ停止）。

要望を精査した結果、以下の**3つの操作を明確に分離**する必要があることが分かった。

- **探索 (discover)**: リンク構造を辿って対象を発見する。例: sitemap-index → 子Sitemap → さらに子Sitemap。
- **監視 (monitor)**: 実URLを取得し本文の差分を検知する。
- **配信 (deliver)**: 検知した変化を通知する。

要望の要点:

- `sitemap → sitemap → … → page → 配信` という**探索して発見したものを配信する**流れは欲しい。
- しかし `sitemap → … → page → 監視 → 配信`、すなわち**発見したpageを自動で監視対象にする**連鎖はやらない。
- `page → 監視 → 配信` は、**人が手動でpageを登録した場合の単体機能**として既に存在する。
- **Source/Monitorを動的に自動生成すること（auto-promotion）は採用しない**（「動的に増やすは厳しい」）。
- 当面は「**Sitemapの探索くらい**」に絞る。

ベースライン化（feed/sitemapの初回はChangeを作らずTargetのみ記録）は既に導入済みで、本ADRの前提になる。

## Decision

### 1. 探索・監視・配信を分離する

- **探索**は1つのSource内で完結させる。探索の結果として新しいSource/Monitorを動的生成しない。
- **監視**（実URLの取得と差分）は、人が明示的に登録したpage Sourceに対してのみ行う。
- Change Eventは配信されるが、**Changeが新しいSourceを生むことはない**（ADR初版の auto-promotion 案は撤回）。

### 2. sitemap-index Sourceはネストした子Sitemapを探索する

- `sitemap-index` Sourceは、index本体に列挙された子Sitemapを監視itemとし、**子がさらにsitemap-indexの場合は再帰的に辿る**（深さ上限まで）。
- 探索の末端で得られる監視itemは**Sitemap URL（loc）とその lastmod**である。
- 検知対象:
  - 子Sitemap URL（loc）の増加・減少
  - 子Sitemapエントリの lastmod 変化
- **実URL（page loc / urlset内のURL）は展開しない**。sitemap（urlset）の中身までは辿らない。

### 3. 実URLの監視は手動のまま

- 探索で発見したものはあくまで「Sitemapの一覧」である。個別記事URLを差分監視したい場合は、利用者がそのURLを`page` Sourceとして手動登録する。
- 将来的に「探索で発見した実URLを配信し、そこから手動でpage監視へ繋ぐ導線」をUIで提供しうるが、本ADRのスコープ外とする（下記「将来」）。

### 4. 増分のみを配信する（ベースライン前提）

初回チェックはベースライン（全件Target登録・Change 0件）。以降に増えた子Sitemapや、lastmodが変化したものだけをChangeとする。初回の大量発見を通知しない。

### 5. 探索の歯止め

ROADMAPのガードレール（コスト・回数上限）に従う。

- **探索の深さ上限**（既定3: 入れ子のsitemap-indexを辿る段数）。
- **1チェックあたりの子Sitemap数の上限**。超過時は無言で打ち切らず、ログとChange（またはSourceメタ）に「N件を探索せず打ち切った」ことを記録する。
- 探索は**親Siteのcanonical origin内**に限定する。越境するSitemap URLは辿らない（記録・配信はしてよい）。

### 6. 非目標

- Source/Monitorの動的自動生成（auto-promotion）。
- 発見した実URLの自動監視。
- sitemap（urlset）配下の実URLの一括Target化（これが6,021 URL障害の原因であり、本ADRで明示的に行わないと決める）。
- 汎用DAGワークフロー編集（SPEC非目標のまま）。

## Consequences

### Positive

- sitemap-indexは子Sitemap数（通常数十件）だけを見るため、一括展開の実行制限問題が構造的に消える。
- 探索・監視・配信の分離により、「何を発見しただけか」と「何を実際に取得して差分監視しているか」が明確に区別される。
- 動的にSourceが増えないため、Source数・コスト・可視化が予測可能なまま保たれる。
- 既存のSource / Monitor / Change / Subscription基盤を再利用する（新しい実行モデルを持ち込まない）。

### Negative

- 入れ子のsitemap-indexを辿る再帰探索と、深さ・数・origin境界の制御が必要。
- 「Sitemap URLの監視」と「実URLの監視」でSourceの意味が分かれるため、UI・用語での区別が要る。
- 実URLの新着を追いたい利用者は手動でpage登録する手間が残る。

## 将来 (本ADRのスコープ外)

- 探索を実URL（page loc）まで伸ばし、**新着URL自体を配信**する（監視はしない）。大量件数時の配信抑制（Digest化・上限）が前提。
- 発見した実URLから、UI上のワンクリックで手動page監視を作る導線。
- これらはROADMAP Phase 2（Connector抽象化）/ Phase 5（Adaptive Orchestration）で扱う。

## 段階的実装計画

- **Phase A**: `sitemap-index`の挙動変更 — 子Sitemapのloc/lastmodを監視itemとし、実URL（urlset内）を展開しない。これ単体で6,021 URL問題を解消する。
- **Phase B**: 入れ子のsitemap-indexを深さ上限つきで再帰探索する。origin境界・子数上限・打ち切り記録を入れる。
- **Phase C**（将来）: 実URL探索→配信（監視はしない）と、手動page監視への導線。

Phase Aは即座に実運用の障害（stuckした巨大sitemap監視）を解消する。

## SPEC / ROADMAPとの関係

- 本ADRはROADMAP Phase 2（Connector/Processor抽象化）の方向の最初の具体化である。
- 実装が進んだ段階で`SPEC.md`の実装範囲に反映する。現時点では設計判断の記録に留める。
- ROADMAP §4のガードレール（冪等・監査・コスト上限・許可境界）を探索機構に適用する。
