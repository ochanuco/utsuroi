# ADR-0010: 検知チェーンとSource自動昇格

- **Status**: Proposed
- **Date**: 2026-07-11

## Context

MVPの監視は単発である。1つのSourceが1つの入力を取得し、変化を検知して通知する。しかし実運用では「発見したものを次の監視対象にする」連鎖が必要になる。

具体例（実際に要望された利用像）:

```text
sitemap-index を監視
  └─ 子SitemapのURL増加 / lastmod変化を検知 ──▶ 配信
        └─(昇格)▶ その子Sitemapを sitemap Source として監視
              └─ 新着記事URLを検知 ──▶ 配信
                    └─(昇格)▶ その記事を page Source として監視
                          └─ 本文差分を検知 ──▶ 配信
```

現行実装は sitemap-index を受け取ると子Sitemapをその場で全展開し、配下の実URLをすべてTarget化していた。これは初回に数千件のChangeを生成し、Workersの実行制限を超えてジョブが完走しない障害を起こした（本番でsitemap-index監視が6,021 URLを生成しジョブ停止）。一括展開は「連鎖」ではなく「一段での爆発」である。

ADR-0006（決定論的差分）とベースライン化（feed/sitemapの初回はChangeを作らずTargetのみ記録）は既に導入済みで、これが本ADRの前提になる。

## Decision

### 1. 各Sourceは自階層のみを監視する

- `sitemap-index` Sourceは、**index本体に列挙された子Sitemapのリスト（loc と lastmod）だけ**を監視対象itemとする。子Sitemapを取得（fetch）して配下の実URLを展開しない。
- 検知するのは (a) 子Sitemap URL（loc）の増減、(b) 子Sitemapエントリの lastmod 変化。
- `sitemap`（urlset）Sourceは配下の実URL（item）を監視itemとする。
- `page` Sourceは本文差分を監視する。

### 2. Change Eventは配信と昇格の両方へ流せる

Change Eventは従来どおりSubscriptionにより配信される。加えて、**昇格ルール**に一致するChangeは新しいSourceを自動生成する（＝監視チェーンを一段伸ばす）。

固定の昇格ルール（限定パターンのみ。ユーザー定義の汎用ルールは対象外）:

| 元Source | 対象Change | 生成するSource |
|---|---|---|
| `sitemap-index` | 新規の子Sitemap loc | `sitemap` Source |
| `sitemap` | 新規の item URL | `page` Source |

- lastmod変化は昇格しない。既存の子Sitemap/記事Sourceを再チェックすれば自然に下流の変化として伝播するため。
- `page`は末端で、昇格しない。

### 3. 増分のみを昇格する（ベースライン前提）

初回チェックはベースライン（全件Target登録・Change 0件・昇格0件）。以降に**増えた分だけ**がChangeとなり昇格の入力になる。これにより初回の大量発見が連鎖爆発しない。本ADRはベースライン化に依存する。

### 4. Provenance（生成の由来）を記録する

- 生成された`sources`に、生成元の`change_id`と親`source_id`を記録する。
- チェーンの親子関係を追跡でき、UIで可視化・監査でき、重複生成を防げる。

### 5. 冪等・重複制御

- 同一Site内で同一URLのSourceは再生成しない（`sources`の一意制約に依存）。
- 既に監視中のURLが再度Changeとして現れても、新Sourceは作らず既存を維持する。

### 6. 全自動＋上限ガード

昇格は自動で行うが、ROADMAPのガードレール（コスト・回数上限、許可境界、説明可能性）に従い、以下を必須の歯止めとする:

- **深さ上限**: チェーンの段数に上限（既定3: index→sitemap→page）。
- **生成数上限**: 1チェックあたり／1監視あたり／1Siteあたりの新規Source生成数に上限。
- **ドメイン境界**: 昇格で生成するSourceは**親Siteのcanonical origin内**に限定する。越境URLは昇格しない（Change記録・配信はしてよい）。これはSSRF検査（ADR未番号/§15）や robots（ADR-0008）とは独立した「拡散」制御レイヤである。
- **コスト／回数上限**: Policyに含める（ROADMAP §4）。
- 上限に達した場合は**無言で打ち切らない**。ログとChange（またはSourceのメタ）に「N件を昇格せず打ち切った」ことを記録する。

### 7. 非目標

- 任意のグラフを組む汎用DAGワークフロー編集（SPEC非目標のまま）。本ADRは`index→sitemap→page`の**固定パターン**の限定チェーンに限る。
- ユーザー定義の昇格ルール、条件分岐、AI判定による昇格。将来のPhaseで検討する。
- 昇格の手動承認フロー。今回は「全自動＋上限ガード」を採用（ユーザー決定）。将来、承認制をオプションとして追加しうる。

## Consequences

### Positive

- sitemapから記事本文の差分検知まで、人手を介さず監視が伸びる。
- 各段は既存のSource / Monitor / Change / Subscription基盤を再利用する（新しい実行モデルを持ち込まない）。
- 増分ベースなので軽量。sitemap-indexは子Sitemap数（通常数十件）のみを見るため、一括展開の実行制限問題が構造的に消える。
- Provenanceにより「なぜこのSourceが監視されているか」を説明できる。

### Negative

- Source数が動的に増える。上限・可視化・重複管理・監査が必要になる。
- 昇格ルールの実装と、ドメイン境界／深さ／数の制御が必要。
- UIにチェーン（親子）の表示と、自動生成Sourceの区別が必要。
- `sources`/`changes`スキーマにprovenance列の追加（マイグレーション）が必要。

## 段階的実装計画

- **Phase A**: `sitemap-index`の挙動変更 — 子Sitemapのloc/lastmodを監視itemとし、実URLを展開しない。これ単体で6,021 URL問題を解消する。
- **Phase B**: 1段の昇格（`sitemap-index`の新規子loc → `sitemap` Source）+ provenance + 冪等 + ドメイン境界 + 生成数上限。
- **Phase C**: 2段目（`sitemap`の新規item → `page` Source）+ 深さ上限。
- **Phase D**: UIでのチェーン可視化（親子ツリー、自動生成Sourceの明示、昇格の一時停止）。

各Phaseは独立してデプロイ可能とし、Phase Aは即座に実運用の障害（stuckした巨大sitemap監視）を解消する。

## SPEC / ROADMAPとの関係

- 本ADRはROADMAP Phase 2（Connector/Processor抽象化）およびPhase 5（Adaptive Information Orchestration）の方向に踏み込む最初の具体化である。
- 実装が進んだ段階で`SPEC.md`の実装範囲に反映する。現時点では設計判断の記録に留める。
- ROADMAP §4のガードレール（承認・冪等・監査・取消可能性・コスト上限・許可境界）を昇格機構に適用する。
