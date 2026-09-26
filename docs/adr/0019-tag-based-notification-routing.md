# ADR-0019: Change のタグによる通知ルーティング（Classify 段と Subscription.tag）

- **Status**: Proposed
- **Date**: 2026-09-26

## Context

通知の宛先は Subscription の `site_id` / `monitor_id` / `change_kind` だけで決まる
(`listMatchingSubscriptions`, `src/db/destinations.ts`)。Change の中身では宛先を変えられない。

このため、内容で宛先を分けたい場合は Source を分けるしかない。SUUMO は町丁目コード (`oz`) ごとに
検索URLを分けた 14 Source で監視しているが、宛先はすべて同じで、分割の目的は検索条件の絞り込みに
すぎない。ひらつーのように1本のフィードに市内全域の記事が混ざる Source では、「くずはの記事だけ
別スレッドへ」のような振り分けがそもそも表現できない。

一方で、振り分けに必要な材料は揃いつつある。

- `subscriptions.tag` 列は初期スキーマ (`migrations/0001_init.sql`) から存在し、API でも保存できるが、
  ファンアウトの一致条件には使われていない。
- ADR-0016 は Detect と Notify の間に Analysis 段を挿せる形に整理済みで、Enrich 段
  (`enrichTitle.ts`) が最初の具体例として動いている。
- 構造化された値 (ADR-0013 の `extract.fields`、例: 所在地) は文字列一致で確実に分類できる。
- 非構造の記事本文は、Workers AI の `typesafe/jev` で分類できる。jev は noul / choice / score の
  型付き質問に確率と confidence を返す評価モデルで、ひらつー最新10記事の試行では、エリア候補・
  「場所が主題か」・「市内か」を本文の地名と矛盾なく判定できた。値の抽出はできない。

Discord 側は Webhook のままで足りる。チャンネルの振り分けは Webhook ごとの Destination で、
既存スレッドへの投稿は Webhook URL の `thread_id` クエリで実現できる。

## Decision

### 1. Change にタグを付け、Subscription.tag で宛先を選ぶ

- Change は0個以上のタグ (例: `area:kuzuha`, `topic:non-local`) を持つ。
- ファンアウトの一致条件に `subscriptions.tag` を加える。
  - `tag IS NULL` は従来どおりワイルドカードで、タグに関係なくすべての Change に一致する。
    既存の Subscription の挙動は変わらない。
  - `tag` が非NULLの Subscription は、その値を持つ Change にだけ一致する。
- 1つの Change が複数の Subscription に一致すれば、それぞれへ配送する。冪等キー
  `change_id + destination_id` (ADR-0007) は変えない。

### 2. タグは Classify 段が付ける

パイプラインを `Detect → Enrich → Classify → Notify` とする。Classify は Source config の
`classify` で opt-in し、未設定の Source では何もしない。

```jsonc
{
  "classify": {
    "rules": [
      // 決定論ルール: title / url / summary / fields.<name> を正規表現で照合
      { "tag": "area:kuzuha", "match": { "field": "所在地", "pattern": "楠葉|樟葉" } },
      // jev ルール: 質問の答えに対する閾値条件
      { "tag": "area:kuzuha", "jev": { "question": "area", "choice": "kuzuha", "min": 0.6 } },
      { "tag": "topic:non-local", "jev": { "question": "location_bound", "noul_max": 0.5 } }
    ],
    "jev_questions": { /* typesafe/jev の questions をそのまま保持 */ },
    "default_tag": "area:other"
  }
}
```

- 決定論ルールで分類できる値には jev を使わない (SPEC 4.3「決定論的差分を優先する」)。jev は
  場所や話題が文章に埋まっている Source のためのもの。
- `default_tag` は、どのルールにも一致しなかった Change に付ける。「その他」の宛先は
  このタグの Subscription として表現し、ワイルドカード Subscription の特別扱いは設けない。
- jev に渡す state は、Detect 時点で手元にある Item の `title` / `url` / `summary` / `fields` に
  限る。分類のために記事ページを追加取得しない。
- jev への質問は1 Source につき1回の呼び出しにまとめる (全ルールの質問を `jev_questions` に集約)。
  質問数・選択肢数・criteria 長に上限を設け、1チェックあたりの jev 呼び出し数にも
  Enrich 段の `MAX_TITLE_FETCHES_PER_CHECK` と同様の予算を持たせる。

### 3. Classify は Change を落とさない。失敗しても通知は止めない

- Classify の役割はタグ付けだけで、Change の挿入や記録を省くことはしない。「通知しない」は
  そのタグの Subscription を作らないことで表現する。
- jev の呼び出しが失敗した、または予算を超えた場合、その Change の jev ルールは不一致として扱い、
  決定論ルールの結果と `default_tag` だけで配送する (fail-open)。
- タグは Change と同じタイミングで永続化し、再試行時 (`inserted=false`) は保存済みのタグを使う。
  同じ Change に対して jev を二度呼ばず、再試行で宛先が変わらないようにする。

### 4. Destination に任意の thread_id を持たせる

Destination に `thread_id` を追加し、設定されていれば Webhook URL に `?thread_id=` を付けて送る。
Discord bot は導入しない。

## Alternatives

- Discord bot を導入してチャンネル・スレッドを振り分ける: 振り分け自体は Webhook と
  `thread_id` で足り、bot はトークン管理・権限設定・Interactions エンドポイントを新たに抱える。
  bot が必要になるのは通知への操作 (ボタンによるフィードバック、Phase 3 の手動承認) を扱うときで、
  そのときに別 ADR で判断する。
- Source を宛先ごとに分割する (現在の SUUMO の構成): フィード1本に内容が混在する Source では
  成立せず、Source 数と取得回数が宛先の数だけ増える。
- Classify で Change を破棄するフィルタにする: 誤判定した Change が記録ごと消え、判定の検証も
  ルールの後追い修正もできなくなる。タグ付けに留め、宛先の選択で表現する方が安全側に倒れる。
- すべての分類を jev に任せる: 所在地のような構造化値まで確率判定になり、再現性を失う。

## Consequences

- `changes` にタグの保存先 (JSON 配列の列) を追加するマイグレーションが必要になる。
  `listMatchingSubscriptions` は Change のタグを受け取り、`tag IS NULL OR tag IN (…)` で絞る。
- DetectedChange (ADR-0016) は、Classify のために元の Item (`summary` / `fields`) を運ぶ必要がある。
- `sources.config` に `classify` を追加し、作成・PATCH (ADR-0013) で同じ検証をかける。
  jev ルールが参照する質問名・選択肢名が `jev_questions` に存在することも検証対象になる。
- Workers AI の AI binding が本番 Worker に加わり、jev の利用料が新着件数に比例して発生する。
- SUUMO の 14 Source は、市全域の検索URL1本と所在地の決定論ルールに集約できるようになる。
  ただし一覧の1ページに収まらない新着を取りこぼさない取得条件 (並び順・件数) の確認が前提になる。
