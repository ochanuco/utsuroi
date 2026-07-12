# ADR-0015: traverse対象の子sitemapをincludeパターンで絞り込む

- **Status**: Proposed
- **Date**: 2026-07-12

## Context

sitemap-index の traverse モード (ADR-0010 Phase B) は、lastmod cutoff 内の子sitemapを
最大 MAX_CHILD_SITEMAPS (20) 件まで辿る。実サイト (hira2) では子sitemapが63件あり、
記事 (post-sitemap*.xml) のほかにタグ (post_tag-sitemap*.xml ×17)・カテゴリ・エリア・
著者などのアーカイブ系sitemapが混在する。

これにより2つの問題が起きた。

1. **アーカイブ系sitemapの流入**: サイト側のsitemap再生成を契機にタグ系sitemapが探索枠に
   入り、タグアーカイブURL 256件が一度に 'new' Change として通知された (2026-07-12朝)。
   利用者が監視したいのは記事のみで、アーカイブ系は監視対象として不要だった。
2. **枠の浪費**: cutoff内の子が常時20件を超え、毎チェック childrenTruncated が発生。
   不要なアーカイブ系sitemapが記事sitemapの枠を奪っていた。

## Decision

### 1. `child_include_patterns` 設定を追加する

sitemap / sitemap-index 専用の config キー (traverse モードでのみ意味を持つ):

```jsonc
{
  "sitemap_mode": "traverse",
  "child_include_patterns": ["post-sitemap*.xml"]
}
```

- 文字列配列 (1..10件、各1..200文字)。未指定なら従来どおり全子sitemapが対象。
- 指定時、**いずれかのパターンにマッチする子sitemapだけ**を traverse 対象とする。
  マッチしない子は Target 登録もフェッチもしない (探索枠を消費しない)。

### 2. マッチ仕様: URLパス末尾 (ファイル名) への glob

- パターンは子sitemap URL の **パス最終セグメント (ファイル名)** に対して評価する。
- glob は `*` (0文字以上の任意文字) のみサポート。その他の文字はリテラル。大文字小文字は
  区別する。
- 例: `post-sitemap*.xml` は `post-sitemap.xml` / `post-sitemap2.xml` にマッチし、
  `post_tag-sitemap.xml` にはマッチしない (部分一致だと `post` を含むため誤マッチする —
  ファイル名アンカーの glob を採用する理由)。
- ネストした子sitemap-index (中間ノード) にも同じパターンを適用する。中間ノードが
  マッチしない場合、その配下には到達しない (パターンは利用者が index 階層を理解して
  書く前提。v1 では階層別パターンは持たない)。

### 3. 適用範囲

- traverse の子選択 (selectChildEntries 相当) のみ。direct モード (一覧差分) の item には
  適用しない (あちらは「一覧の差分」自体が目的のため)。
- 検証は API 層 (作成時 / PATCH 時) で行う: sitemap系専用キー、配列上限、空文字拒否。

## Alternatives

- **URL除外パターン (exclude)**: 「不要なものを列挙する」方式は新種のアーカイブが
  増えるたびに漏れる。今回の要件は「記事だけ欲しい」であり include の方が安全側に倒れる
  (知らない子は辿らない)。
- **実URL側のパターンフィルタ**: 子sitemap自体はフェッチしてしまうため枠の浪費が
  解決しない。
- **子sitemap初回展開のbaseline化**: 通知floodへの構造的対策としては別途有効だが、
  「そもそもタグ系を監視しない」という今回の要件には include パターンが直接的。
  baseline化は将来の別ADR候補として残す。

## Consequences

- hira2 は `["post-sitemap*.xml"]` を設定することで、記事以外の子sitemapを辿らなくなり、
  タグ系flood の再発と childrenTruncated の常態化が同時に解消する。
- include 方式のため、サイトが新しい種類のsitemapを追加しても勝手に監視対象が広がらない
  (広げたい場合はパターンを足す)。
- パターン未設定の既存Sourceは挙動不変。
