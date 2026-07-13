# ADR-0016: Source Pipeline を可変Stage合成として表現する

- **Status**: Proposed
- **Date**: 2026-07-13

## Context

1回の Check 実行 (ADR-0003, `runMonitorCheck`) の内容処理は現在、Source 種別と config に
応じた `if/else` で 5 つの手続き関数を呼び分けている (`src/pipeline/runCheck.ts:240-254`)。

```
if (page && extract)       processPageItems(ctx, target, lastAttemptId, outcome, body)
else if (page)             processPageContent(ctx, target, latestSnapshot, ...)
else if (sitemap+traverse) processSitemapTraversal(...)
else if (sitemap)          processSitemapDirect(ctx, target, latestSnapshot, ...)
else                       processFeedContent(...)
```

この構造には3つの問題がある。

1. **段が癒着している**: 各 `process*` の内部で Extract → Diff (snapshot比較・dedupe) →
   Change 挿入 → Notify ファンアウト (`NOTIFY_QUEUE.send`) までが一続きに実装されている。
   Extract だけ差し替える、Diff を挟まず全アイテムを通知する、といった組み替えができない。
2. **段のインターフェースが揃っていない**: `processPageContent` は `latestSnapshot` を取り、
   `processPageItems` は取らないなど、シグネチャがバラバラで共通の抽象がない。ROADMAP で
   「Processor 抽象」と呼んでいるものの実態は共通型を持たない関数群と `if/else` である。
3. **monitor ごとに必要な段の構成が異なる要求に応えられない**: 実運用では「本文差分は
   要らず Extract した結果を毎回そのまま通知したい (Fetch→Extract→Notify)」「将来 Extract と
   Notify の間に要約 (Analysis) を挟みたい」といった、monitor 単位で段構成が変わる期待がある。
   現状は種別ごとに太い関数が固定でぶら下がっているため、この可変性を表現できない。

なお「段ごとに独立した Durable Object を立て、Input/Output を DO 間で繋ぐ」案も検討したが、
Extract/Diff/Notify-fanout は**ステートレスな変換**であり、DO の強み (単一インスタンスによる
排他・状態一貫性) を使わずコスト (storage 課金・RPC ホップ・単一 DO でのボトルネック直列化・
トランザクション境界の分断) だけを負う。ADR-0002 も「長期本文・履歴は D1/R2 へ、DO storage に
蓄積しない」と決めており、パイプラインの段を DO 境界にマッピングする設計思想は ADR-0001/0002 に
そもそも存在しない。DO 分割軸は「排他制御の一意性・ライフサイクル」(monitor 直列化 / host
rate-limit / 外部 executor 容量) である。

## Decision

Source の内容処理を、**monitor 設定が構成を決める可変 Stage 合成 (Pipeline)** として表現する。

### 1. Pipeline は Stage の列。構成は monitor (source config) が決める

`runCheck` の `if/else` を、Source 種別 → Stage 列 (レシピ) の対応表**1箇所**に集約する。

```
page-content     : [Fetch, ContentDiff, Notify]
page-extract     : [Fetch, ItemExtract, Diff, Notify]
sitemap-direct   : [Fetch, SitemapDiff, Notify]
sitemap-traverse : [Traverse,           Diff, Notify]
```

monitor ごとの構成差は**配列の増減**で表現される。例:

```
毎回全通知 monitor : [Fetch, ItemExtract,       Notify]   // Diff を抜くだけ
将来の要約付き     : [Fetch, ItemExtract, Diff, Analysis, Notify]
```

### 2. 段間の中間表現を `Item[]` 一本に統一する

Stage をバラバラの `In→Out` 型にすると `ItemExtract (→Item[])` を `Notify (Change[]→)` へ
直結できず、可変合成が型パズルで詰む。これを避けるため、**取得以降の段はすべて `Item[]` を
受けて `Item[]` を返す変換**に揃える。

- `Diff` は「必須の段」から「**新規/変更のみ残す絞り込み Stage** (`Item[]→Item[]`)」に
  格下げされ、抜き差し自由になる。これにより `Extract→Notify` (Diff スキップ) が型を保った
  まま成立する。
- `Notify` も `Item[]→Item[]` (副作用で Queue enqueue する passthrough) とし、後段をさらに
  繋げられる余地を残す。
- 既存の `FeedItem` / `ExtractedItem` (ADR-0011/0013) を段間の共通通貨として流用する。

### 3. Stage は2系統。取得内包 Stage が再帰 fetch を閉じ込める

```
① 純変換 Stage    : Item[] → Item[]        (Diff, Analysis, Notify …大多数)
② 取得内包 Stage  : TargetRef → Item[]      (fetcher を CheckContext 経由で受け、
                    内部で取得を行う。Fetch は1回、Traverse はループ)
```

- `sitemap-traverse` の実体は `Fetch→Extract→Fetch→…` の再帰だが、これを**パイプライン抽象の
  ループ/再帰プリミティブにはしない** (traverse だけのために全 monitor が背負う複雑さが
  割に合わない)。再帰は `TraverseObject` という取得内包 Stage の**内部実装**に閉じ込め、
  パイプラインからは `TargetRef → Item[]` の1段に見せる。
- fetcher は既に `CheckContext` で全段に渡っている (`src/pipeline/runCheck.ts`)。取得内包 Stage が
  それを使うのは抽象の漏れではなく正規の入力である。「Fetch は必ず最初の独立した1段」という
  前提を「取得は Stage の一種の能力」に緩めることで、traverse は例外ではなく②の代表例になる。

### 4. Durable Object 境界は変更しない

- 一貫性 (排他・直列化) は従来どおり `MonitorObject` が担う。Pipeline 全体はその single-thread
  実行コンテキスト・同一 DB セッションで直列に走るため、一貫性は現状と同一。
- Stage は**プレーンオブジェクト** (DO ではない)。新しい DO は追加しない。
- Queue 境界は `Notify` Stage の内部に閉じる (現状と同じ。enqueue までが同期範囲、実配信は
  ADR-0007 の Queue consumer)。

## Alternatives

- **段ごとに独立 DO (`ExtractObject` 等) を立て RPC で繋ぐ**: ステートレス変換に stateful
  single-instance を被せる。単一 DO 化すれば全 monitor がそこで直列化しボトルネック、monitor
  ごとに分ければ MonitorObject と同粒度で切り出す意味が消える。Context 記載のとおり却下。
- **段ごとに Queue を挟む**: 一貫性境界 (現状は1 check = 1トランザクション的スコープ) が
  分断され、レイテンシと途中失敗時の整合設計コストが増える。Notify のみ Queue 化する現状の
  一貫性を壊す。却下。
- **Cloudflare Workflows (durable execution) で段を表現**: 段ごとのリトライ・永続・長時間実行が
  主目的なら本命。ただし今回の目的は「差し替え性・見通しと monitor ごとの可変構成」であり、
  Workflows は過剰。将来 Analysis 段が重く/長くなり耐障害が要件化したら再検討する別ADR候補。
- **厳密な `Stage<In, Out>` 型チェーン**: 型安全だが可変合成が TypeScript の型パズルになり
  monitor ごとの段の抜き差しが困難。Decision 2 の中間表現統一で「型は保ちつつ可変」を得る方を採る。
- **パイプラインに再帰/ループを第一級プリミティブとして入れる**: traverse だけのために抽象
  全体が複雑化する。取得内包 Stage 内に閉じ込める方 (Decision 3) が安い。

## Consequences

- `runCheck` の内容処理ディスパッチが「レシピ表引き + Stage 列の逐次実行」に一本化され、段の
  抜き差しが配列操作になる。新しい監視モードの追加が「Stage を1つ足してレシピに載せる」で済む。
- **移行**: 既存 5 手続き (`processPageContent` / `processPageItems` / `processSitemapDirect` /
  `processSitemapTraversal` / `processFeedContent`) を Stage に分解する必要がある。とくに現状
  `processFeedItems` 系が抱えている **Diff と Notify-fanout の癒着を解く**のが要。段境界での
  失敗確定・冪等性 (現状は runCheck の単一 try/catch で `failed` 確定し、`createCheckJobIfNew` の
  冪等キーを壊さない) を分解後も同等に保つこと。既存テストスイートを回帰の担保とし、段単位の
  ユニットテストを追加する。
- traverse の再帰は取得内包 Stage 内に閉じるため、**fetch 回数・DO 実行時間は現状と不変**
  (root 1 + 子 MAX_CHILD_SITEMAPS、ADR-0010/0015)。Stage 化による実行コスト増はない。
- **将来の拡張点**: (a) Extract と Notify の間に Analysis 段 (要約・分類等) を挿す、(b) 対象が
  育って traverse が1 check に収まらなくなった場合に発見 URL を Target へ昇格し BFS で check を
  跨ぐ (ADR-0010 が将来枠に残した「発見URL→監視昇格」)。いずれも本ADRの Stage 合成の上に
  別ADRとして載せられる。
- ADR-0011「Processor 抽象」は、本ADRの Stage 抽象に発展的に置き換えられる (Processor 抽象の
  当初意図を可変合成として具体化したもの)。
