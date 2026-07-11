# ADR-0010: Sitemap監視のモード分離（Direct差分 と lastmod探索）

- **Status**: Proposed
- **Date**: 2026-07-11

## Context

MVPの監視は単発である。1つのSourceが1つの入力を取得し、変化を検知して配信する。

sitemap-indexを監視する際、現行実装は子Sitemapをその場で全展開し、配下の実URLをすべてTarget化していた。これは初回に数千件のChangeを生成し、Workersの実行制限を超えてジョブが完走しない障害を起こした（本番でsitemap-index監視が6,021 URLを生成しジョブ停止）。

要望を精査した結果、以下の**3つの操作を明確に分離**する必要があることが分かった。

- **探索 (discover)**: リンク構造を辿って対象を発見する。sitemap-index → 子Sitemap → 実URL。
- **監視 (monitor)**: 対象を取得し差分を検知する。
- **配信 (deliver)**: 検知した変化を通知する。

そのうえで、探索の量を抑える方法として2つのアプローチが要ることが分かった。

- lastmodを信頼できるサイトでは、**lastmodベースの差分探索**で変化した枝だけを辿れる。
- lastmodを更新しないサイトでは探索が成立しない。その場合は探索せず、**指定した階層のsitemapのURL集合そのものの差分**を見れば十分（Page監視に近い）。

要望の要点:

- `sitemap → … → page → 配信`（探索して発見した実URLの新着・更新を配信）は欲しい。
- `sitemap → … → page → 監視`（発見したpageを自動で本文監視対象にする）はやらない。
- `page → 監視 → 配信`（手動page登録）は既存の単体機能。
- Source/Monitorの動的自動生成（auto-promotion）は採用しない。
- lastmod非依存の代替として「Sitemapを直接1枚のドキュメントとして差分監視するモード」を持つ。

ベースライン化（feed/sitemapの初回はChangeを作らずTargetのみ記録）は既に導入済みで、本ADRの前提になる。

## Decision

### 1. 探索・監視・配信を分離する

- **探索**は1つのSource内で完結させる。探索の結果として新しいSource/Monitorを動的生成しない（auto-promotionは撤回）。
- 実URLの**本文差分監視**は、人が明示的に登録したpage Sourceに対してのみ行う。
- Change Eventは配信されるが、Changeが新しいSourceを生むことはない。

### 2. Sitemap監視の2モード

Sitemap系Sourceは以下のいずれかのモードで動く（Source設定で選択）。

#### モードA: Sitemap Direct（lastmod非依存・既定）

- 指定した**1つのsitemap**（sitemap-index / urlset どちらでも）を取得し、**その階層に直接列挙されているURL集合（loc、任意でlastmod）を1つのドキュメントに正規化**する（loc昇順・重複排除）。
- そのドキュメントを、既存のPage監視と同じ **snapshot + 決定論的diff**（ADR-0006）で前回と比較する。
- **子を辿らない（探索しない）。実URLの本文を取得しない。個々のURLをTarget化しない。**
- 検知: URL集合の**増加・減少**（diffの追加/削除行）。lastmodを列に含めれば更新も差分に出る。
- lastmodに一切依存しない。**6,021件規模でもsnapshotは1件・diffは1回**で、Target爆発が起きない。
- 「指定した階層」を直接見る:
  - sitemap-indexを指定 → 子Sitemapのloc集合を監視。
  - 特定のurlsetを指定 → その実URLのloc集合を監視。
- lastmodを更新しないサイトでも確実に増減を検知できる。これを**既定モード**とする。

#### モードB: Sitemap探索（lastmodベース・高機能）

- sitemap-indexの子Sitemapのうち、**lastmodが前回チェックから変化したものだけ**を取得・再帰探索する（入れ子のsitemap-indexも深さ上限まで辿る）。
- **lastmodが直近N日（既定3日、設定可能）より古いエントリは対象外**とする。
- 探索は urlset の**実URL**まで到達し、実URLの**新規出現・lastmod更新をChangeとして配信**する（本文は取得しない）。
- 変化のあった枝だけを展開するため軽量。lastmodを信頼できるサイト向け。
- lastmodに依存する（下記トレードオフ）。

### 3. 増分のみを配信する（ベースライン前提）

- 初回チェックはベースライン: 記録のみ、Change 0件・配信0件。
- モードA: 初回にURL集合ドキュメントのsnapshotを取るだけ。以降その差分。
- モードB: 初回に子Sitemapのlastmodを記録し、実URLを一括展開しない。以降lastmodが変化した子だけ展開する。

### 4. 実URLの本文監視は手動のまま

探索・配信は「どのURLが増えた・更新された」までを扱う。個別記事の本文差分を追いたい場合は、利用者がそのURLを`page` Sourceとして手動登録する。発見URLから手動page監視を作る導線はUIで提供しうる（将来）。

### 5. 歯止め（ガードレール、ROADMAP §4）

- モードB: lastmod足切り（既定3日）とlastmod差分探索を主制御、深さ上限（既定3）と1チェックあたり展開数上限を最終防波堤とする。打ち切りは無言にせず記録する。
- 探索・Directとも**親Siteのcanonical origin内**に限定する。越境するSitemap/URLは辿らない（記録・配信はしてよい）。

### 6. 非目標

- Source/Monitorの動的自動生成（auto-promotion）。
- 発見した実URLの自動本文監視。
- 汎用DAGワークフロー編集（SPEC非目標のまま）。

## Consequences

### Positive

- **モードAが最小・堅牢**: 既存のsnapshot+diff基盤を再利用し、Target爆発なし・lastmod非依存で一括展開の実行制限問題を解消する。hira2の障害をこのモードで即解決できる。
- モードBはlastmodを信頼できるサイトで、変化した枝だけを軽量に探索し実URLの新着まで配信できる。
- 探索・監視・配信の分離により、「URL増減を発見・配信しただけ」と「本文を取得して差分監視している」が明確に区別される。
- 動的にSourceが増えないため、Source数・コストが予測可能なまま保たれる。

### Negative

- 2モードの選択・説明がUI/用語に要る。
- モードBはlastmod依存。lastmodを更新しないサイトでは新着を見逃す → モードAまたは手動page登録で対応する（この限界を利用者に明示）。
- モードAは「集合の増減」までしか分からない（どの記事が更新されたかはlastmodを列に含めない限り出ない）。粒度が要る場合はモードBか手動監視。

## 段階的実装計画

- **Phase A**: モードA（Sitemap Direct）を実装し、sitemap系Sourceの既定挙動を「URL集合のsnapshot+diff」に置き換える。現行の一括Target展開を廃止する。**これ単体で6,021 URL問題を解消**し、pausedにしているhira2監視を正常化する。
- **Phase B**: モードB（lastmodベース差分探索）を追加。lastmodが変化した子だけ再帰展開し、実URLの新着・更新を配信。3日足切り・深さ/数上限・origin境界を入れる。
- **Phase C**（将来）: 発見した実URLから手動page監視を作るUI導線。

## SPEC / ROADMAPとの関係

- 本ADRはROADMAP Phase 2（Connector/Processor抽象化）の方向の最初の具体化である。
- 実装が進んだ段階で`SPEC.md`の実装範囲に反映する。現時点では設計判断の記録に留める。
- ROADMAP §4のガードレール（冪等・監査・コスト上限・許可境界）を探索機構に適用する。
