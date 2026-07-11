# ADR-0010: Sitemap探索（lastmodベースの差分探索、探索・監視・配信の分離）

- **Status**: Proposed
- **Date**: 2026-07-11

## Context

MVPの監視は単発である。1つのSourceが1つの入力を取得し、変化を検知して配信する。

sitemap-indexを監視する際、現行実装は子Sitemapをその場で全展開し、配下の実URLをすべてTarget化していた。これは初回に数千件のChangeを生成し、Workersの実行制限を超えてジョブが完走しない障害を起こした（本番でsitemap-index監視が6,021 URLを生成しジョブ停止）。

要望を精査した結果、以下の**3つの操作を明確に分離**する必要があることが分かった。

- **探索 (discover)**: リンク構造を辿って対象を発見する。sitemap-index → 子Sitemap → 実URL。
- **監視 (monitor)**: 実URLを取得し本文の差分を検知する。
- **配信 (deliver)**: 検知した変化を通知する。

要望の要点:

- `sitemap → sitemap → … → page → 配信`、すなわち**探索して発見した実URL（新着・更新）を配信する**流れは欲しい（sitemapを見ればURLは分かる）。
- しかし `sitemap → … → page → 監視 → 配信`、すなわち**発見したpageを自動で監視（本文取得＋差分）対象にする**連鎖はやらない。
- `page → 監視 → 配信` は、**人が手動でpageを登録した場合の単体機能**として既に存在する。
- **Source/Monitorを動的に自動生成すること（auto-promotion）は採用しない**（「動的に増やすは厳しい」）。
- 探索の量は**更新日時（lastmod）ベースで削減する**。

ベースライン化（feed/sitemapの初回はChangeを作らずTargetのみ記録）は既に導入済みで、本ADRの前提になる。

## Decision

### 1. 探索・監視・配信を分離する

- **探索**は1つのSource内で完結させる。探索の結果として新しいSource/Monitorを動的生成しない。
- **監視**（実URLの取得と本文差分）は、人が明示的に登録したpage Sourceに対してのみ行う。探索は実URLの本文を取得しない。
- Change Eventは配信されるが、**Changeが新しいSourceを生むことはない**（ADR初版の auto-promotion 案は撤回）。

### 2. lastmodベースの差分探索

Sitemapプロトコルでは、子Sitemapの内容が更新されると、その子の`<lastmod>`が更新され、親sitemap-index側の該当エントリの`<lastmod>`も更新されることが期待される。これを探索の枝刈りに使う。

- sitemap-indexの子Sitemapのうち、**lastmodが前回チェックから変化したものだけ**を取得・再帰探索する。lastmodが変わっていない子は辿らない。
- さらに、**lastmodが直近N日（既定3日、設定可能）より古いエントリは探索・検知の対象外**とする。古い枝を毎回確認しない。
- これにより、変化のあった枝（通常わずか）だけが展開され、探索リソースが大幅に減る。

補助的な最終防波堤として、探索の深さ上限（既定3）と1チェックあたりの展開Sitemap数の上限も持つ。上限に達した場合は無言で打ち切らず、ログとメタに記録する。

### 3. 探索の対象と検知

探索は sitemap-index → 子Sitemap →（入れ子なら再帰）→ urlset の**実URL**まで到達する。各層で:

- **Sitemap URL（loc）**: 増加・減少、lastmod変化を検知。
- **実URL（urlset内のloc）**: 新規出現（新着）、lastmod変化を検知。

検知したものは**Change Eventとして配信**する（新着URL・更新URL）。**実URLの本文は取得しない**（監視ではなく探索）。

### 4. 増分のみを配信する（ベースライン前提）

- 初回チェックはベースライン: 到達したSitemap/実URLの loc と lastmod を記録するのみ。Change 0件・配信0件。
- 初回は「lastmod変化」判定ができないため、**実URLの一括展開は行わず、まず sitemap-index の子Sitemapの lastmod を記録する**。以降のチェックで lastmod が変化した子だけを展開し、その配下の実URLの新着・更新を検知する。
- これにより初回に6,021件を一度に扱うことがなくなる（障害の再発防止）。

### 5. 実URLの監視は手動のまま

- 探索・配信は「どのURLが増えた・更新された」までを扱う。個別記事の**本文差分**を追いたい場合は、利用者がそのURLを`page` Sourceとして手動登録する。
- 発見した実URLから手動page監視を作る導線をUIで提供しうる（下記「将来」）。

### 6. 探索の歯止め（ガードレール）

ROADMAP §4のガードレールに従う。

- **lastmod足切り**（既定3日）と**lastmod差分探索**を主たるリソース制御とする。
- **深さ上限**（既定3）・**1チェックあたりの展開数上限**を最終防波堤とする。打ち切りは記録する。
- 探索は**親Siteのcanonical origin内**に限定する。越境するSitemap/URLは辿らない（記録・配信はしてよい）。

### 7. 非目標

- Source/Monitorの動的自動生成（auto-promotion）。
- 発見した実URLの自動監視（本文取得＋差分）。
- 汎用DAGワークフロー編集（SPEC非目標のまま）。

## Consequences

### Positive

- lastmod差分探索により、変化のあった枝だけを展開する。初回以降の探索が軽量になり、一括展開の実行制限問題が消える。
- 探索・監視・配信の分離により、「新着URLを発見・配信しただけ」と「本文を取得して差分監視している」が明確に区別される。
- 動的にSourceが増えないため、Source数・コストが予測可能なまま保たれる。
- 既存のSource / Monitor / Change / Subscription基盤を再利用する。

### Negative

- **lastmodに依存する**。lastmodを提供しない、または子更新時に親lastmodを更新しないサイトでは新着を見逃す。この場合は手動page登録で対応する（lastmod非提供の枝を毎回フル展開する挙動は、コスト上限のため既定では採らない）。この限界を利用者に明示する必要がある。
- 入れ子sitemap-indexの再帰探索と、lastmod比較の状態（前回値の保持）が必要。
- 「Sitemap/URLの探索・配信」と「実URLの本文監視」でSourceの意味が分かれるため、UI・用語での区別が要る。

## 将来 (本ADRのスコープ外)

- 発見した実URLから、UI上のワンクリックで手動page監視を作る導線。
- lastmod非提供サイト向けの代替探索戦略（ハッシュ差分など）。
- ROADMAP Phase 2（Connector抽象化）/ Phase 5（Adaptive Orchestration）で扱う。

## 段階的実装計画

- **Phase A**: `sitemap-index`の挙動変更 — 子Sitemapのloc/lastmodを記録・検知し、実URL（urlset内）を初回に一括展開しない。これ単体で6,021 URL問題を解消する。
- **Phase B**: lastmodベースの差分探索 — lastmodが変化した子Sitemapだけを再帰展開し、配下の実URLの新着・更新を検知・配信する。3日足切り・深さ/数上限・origin境界を入れる。
- **Phase C**（将来）: 発見した実URLから手動page監視を作るUI導線。

Phase Aは即座に実運用の障害（stuckした巨大sitemap監視）を解消する。

## SPEC / ROADMAPとの関係

- 本ADRはROADMAP Phase 2（Connector/Processor抽象化）の方向の最初の具体化である。
- 実装が進んだ段階で`SPEC.md`の実装範囲に反映する。現時点では設計判断の記録に留める。
- ROADMAP §4のガードレール（冪等・監査・コスト上限・許可境界）を探索機構に適用する。
