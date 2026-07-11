# ADR-0011: page Source のアイテム抽出モード（新着検知）

- **Status**: Proposed
- **Date**: 2026-07-11

## Context

page Sourceは既定でページ全体の本文差分 (processPageContent, SPEC §12/§13) を監視する。しかし
一覧ページ (賃貸物件一覧・求人一覧・ニュース一覧等) を監視したい場合、利用者が本当に知りたいのは
「ページ全体のHTMLがどう変わったか」ではなく「一覧に含まれる個々のアイテム (物件・記事等) の
どれが新しく現れたか」である。本文差分監視は一覧ページの並び順変化・広告差し替え・日時表示の
更新等でも高頻度に差分を検知してしまい、ノイズが多い。

ROADMAP Phase 2は、Web監視の内部構造から Trigger / Source・Connector / Processor / Policy /
Action・Destination / Run・Attempt / State という共通境界を抽出する方向性を示している。本ADRは
その中の **Processor** 抽象の最初の具体化であり、「ページからアイテム集合を抽出し、アイテム単位で
new/updated を検知する」という、sitemap監視 (ADR-0010) とは異なる第2のProcessorパターンを
page Sourceに追加する。

ADR-0010で確立した「探索・監視・配信の分離」と「発見した実URLの本文監視は行わない」という設計は
本ADRでも維持する。アイテム抽出モードは実URLの本文を取得・監視しない。実URL単位の新着検知・配信
までを扱う。

## Decision

### 1. page Source に2つ目の監視方式 (pageMode) を追加する

`sources.config.pageMode` (既定 `'content'`) で選択する。

- `'content'` (既定, 本文差分): 従来どおり processPageContent。normalizeHtml で正規化した本文全体を
  前回Snapshotと比較する。
- `'extract'` (新着検知, ADR-0011): processPageItems (src/pipeline/pageItems.ts)。CSSセレクタで
  アイテム集合を切り出し、アイテムごとの実URLをTarget化し、new/updated検知・通知は既存の
  processFeedItems (feed.ts, rss/atom/sitemap-traverseと共通のコア) にそのまま委譲する。

ディスパッチは runCheck.ts が `source.type === 'page' && source.config?.pageMode === 'extract'` の
場合のみ processPageItems へ切り替え、それ以外の page は従来どおり processPageContent を通る
(既存の本文差分監視の挙動は一切変えない)。

### 2. 抽出方式: HTMLRewriter (lol-html) によるストリーミング抽出

新規モジュール `src/normalize/extractItems.ts` を追加する。実装前に以下をスパイクで検証し
(test/normalize/extractItems.test.ts の「HTMLRewriter 挙動の固定」describe)、想定どおりに動作
することを確認した。

- `on(itemSelector, { element })` + `element.onEndTag()` で各アイテムの開始/終了境界を取得できる。
- `on(`${itemSelector} ${linkSelector}`, ...)` のような子孫結合子セレクタのハンドラは、item の
  開始/終了イベントと同じ文書順ストリームの中で正しく交互に発火し、「現在開いているアイテム」を
  指す1個のクロージャ変数だけで子孫要素とアイテムを相関できる。centinel コメント挿入方式
  (src/normalize/include.ts) へのフォールバックは不要と判断した。
- text ハンドラはマッチ要素の子孫テキストノードも受け取る (normalize.ts の extractText と同じ)。
- 入れ子アイテム (item要素の内側にさらにitem要素がある場合): lol-html は両方に対して独立に
  element/onEndTag を発火する (自動フラット化はしない)。本実装は itemSelector マッチの深さ
  カウンタを持ち、深さ 0→1 の発火のみを新しいアイテムの開始とみなし、1→0 に戻った発火で確定する
  ことで「外側優先でフラット化する」仕様に固定した (内側の item は独立したアイテムを作らず、
  外側アイテムの内容として取り込まれる)。

抽出したアイテムは既存の共有契約 `FeedItem` (src/shared/contracts.ts) にマッピングし、
`extractItems(body, opts) => Promise<FeedItem[]>` という外部インターフェイスに固定する。

### 3. stableKey = URL、v1は 'new' のみ

- 各アイテムの `url` は、アイテム内で最初に見つかった有効な (http/https に解決できる) リンクの
  href を絶対URL化したもの。`stableKey` はこの url そのもの。
- `title` は `titleSelector` 指定時はそのテキスト、未指定時はurlを提供したリンクのテキストへ
  フォールバックする。前後空白をトリムし256字上限で切り詰める。
- `publishedAt` / `updatedAt` / `summary` は常に `null`。HTMLの一覧アイテムから更新時刻を
  取得する一般的な手段が無い (sitemapのlastmodのような構造化された更新時刻フィールドが無い) ため、
  v1は processFeedItems の 'new' (新規URL出現) 検知のみを対象とし、'updated' は検知しない。
  将来、アイテムの抽出テキスト (title等) のhashをwatermarkとして使い、同一URLの内容変化を
  疑似的な 'updated' として検知する拡張の余地はあるが、v1のスコープには含めない。
- URL が1つも見つからないアイテムは結果から除外する (エラーにはしない)。抽出0件はエラーではなく
  空配列を返す。

### 4. new/updated検知・Target化・通知は processFeedItems に委譲する (再実装しない)

ADR-0010 Phase B (sitemapTraversal.ts) と同じ設計判断として、抽出したアイテム配列を
`processFeedItems(ctx, items)` へそのまま渡す。これにより以下が無償で手に入る。

- baseline化 (monitor初回チェックはTarget登録のみ、Changeを作らない)。
- `MAX_FEED_ITEMS_PER_CHECK` (既定2000件) による1チェックあたりの処理件数上限・打ち切り
  (超過分は次回以降のチェックに持ち越される)。
- dedupeKeyによる冪等upsert・通知ファンアウト (Discord配送、既存のsubscription/delivery機構)。

### 5. config形状

```ts
sources.config: {
  pageMode?: 'content' | 'extract',
  extract?: {
    itemSelector: string,        // 必須 (pageMode==='extract'のとき)
    linkSelector?: string,       // 既定 'a'
    titleSelector?: string,      // 省略時はリンクテキストへフォールバック
  },
  // 既存の正規化オプション (pageMode==='content'向け、本ADR以前から存在):
  ignoreSelectors?: string[],
  includeSelectors?: string[],
  stripQueryParams?: string[],
}
```

API (`POST /api/sources`) は type別にconfigキーを検証する。sitemap系キー (`sitemap_mode` /
`lastmod_max_age_days` / `max_depth`, ADR-0010) は sitemap/sitemap-index のみ、page系キー
(`page_mode` / `extract` / `ignore_selectors` / `include_selectors` / `strip_query_params`) は
page のみに適用可能で、type と組み合わない場合は400 `config_not_applicable` を返す。rss/atomは
従来どおりconfigを一切受け付けない。

`extract.item_selector` は作成時に `new HTMLRewriter().on(selector, {})` を試行し (workerd実測:
不正なセレクタは同期的にthrowする)、パース不能なら400 `invalid_selector` を返す。
`page_mode==='extract'` なのに `extract.item_selector` が無い場合も同じ400 `invalid_selector`
で拒否する。

### 6. セレクタの制約 (lol-html サブセット)

`itemSelector` / `linkSelector` / `titleSelector` は、normalize.ts (src/normalize/normalize.ts:
16-24) のignoreSelectors/includeSelectorsと同じ保証範囲 (タグ名 / `#id` / `.class` / 属性セレクタ /
空白区切りの子孫結合子) を前提とする。擬似クラス等のより高度なセレクタはlol-htmlが対応していれば
動く可能性はあるが、本実装ではテスト・保証の対象外。

### 7. ガードレール

- 1チェックあたりのアイテム処理数上限は既存の `MAX_FEED_ITEMS_PER_CHECK` (processFeedItems) を
  再利用し、新設しない。
- 抽出0件は console.warn で件数を記録するのみに留める (エラーにしない、Changeも作らない)。
  「以前は抽出できていたのに継続的に0件になった」ことを異常として検知する仕組み (セレクタの
  陳腐化・ページ構造変化の検知) はv1のスコープ外とし、将来課題として明記する。

## Consequences

### Positive

- 一覧ページ監視のノイズ (本文差分の過検知) を、アイテム単位のnew検知に置き換えて解消できる。
- new/updated検知・Target化・通知は既存のprocessFeedItemsを再利用するため、実装量・回帰リスクを
  最小化できる。ADR-0010 Phase Bと同じ設計パターンの反復であり、ROADMAP Phase 2の
  「実際に2つ目のユースケースが必要になるまで内部抽象化は最小限にする」方針とも整合する。
- HTMLRewriterのストリーミング処理をそのまま使うため、大きな一覧ページでもDOM全体をメモリ上に
  構築せずに抽出できる。

### Negative

- v1は'updated'を検知できない (lastmodに相当する情報がHTMLの一覧アイテムには一般に無いため)。
  アイテムの内容が変わっても新規出現でない限り検知されない。
- セレクタ (itemSelector/linkSelector/titleSelector) の保守は利用者の責任であり、対象サイトの
  HTML構造変更でセレクタが陳腐化すると無言で抽出0件になりうる (v1では警告ログのみ、継続的な
  異常検知は将来課題)。
- 一覧ページ自体がrobots.txtで禁止されている場合、本ADRのモードを使うには引き続きrobots.txt
  遵守 (ADR-0008) の枠組みに従う必要がある。特に、既存の非公式監視スクリプト (例:
  suumo-watcher的な賃貸一覧監視) をこの機能へ置き換える場合、対象パスがrobots.txtの
  Disallow配下であるケースが多く、その場合はADR-0009の明示的Override (Site所有者ではない
  第三者サイトの監視を続けるには、禁止を理解した上での理由付き有効化が必要) を経由しない限り
  Policy Stopされる。本ADR自体はrobots判定のロジックを変更しない。

## SPEC / ROADMAPとの関係

- 本ADRはROADMAP Phase 2 (Connector/Processor抽象化) の方向性のうち、ADR-0010に続く2つ目の
  Processor具体化である。sitemap監視 (ADR-0010) が「構造化されたURL集合の差分・探索」を扱うのに
  対し、本ADRは「非構造化HTMLからのアイテム抽出」という異なる入力形状に対する共通のProcessor
  適用パターン (=どちらも最終的にprocessFeedItemsのnew/updated検知・通知コアへ収束する) を示す。
- 実装が進んだ段階でSPEC.mdの実装範囲に反映する。現時点では設計判断の記録に留める。
