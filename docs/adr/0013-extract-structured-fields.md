# ADR-0013: アイテム抽出モードの構造化フィールド抽出

- **Status**: Proposed
- **Date**: 2026-07-12

## Context

ADR-0011のアイテム抽出モード (`page_mode: 'extract'`) は、アイテムのURL (linkSelector) と
タイトル (titleSelector またはリンクテキスト) のみを抽出する。通知embedには
タイトル・Site名・URLしか載らず、一覧アイテムが持つ属性情報 (物件監視なら価格・所在地・
面積・間取り等) が落ちる。移行元の非公式監視スクリプト (suumo-watcher) はこれらを構造化
抽出して通知に含めており、置き換えで通知の情報量が後退している。

対象サイトの実HTML (SUUMO一覧) を調査した結果:

- 一部の値には専用クラスがある (例: 価格の `.dottable-value`) が、**所在地・沿線・面積・
  間取り等は `<dl><dt>ラベル</dt><dd>値</dd></dl>` のラベルテキストでしか特定できない**。
  純粋なCSSセレクタ (lol-htmlサブセット) だけでは取り切れない。
- `<dt>&nbsp;</dt>` のようなダミーラベル行が存在し、ラベルの正規化・スキップが必要。
- `<dl>` が `<table>` 内に入れ子になるレイアウトもあるが、ストリーム上 dt → dd の出現順は
  保たれる。

## Decision

### 1. `extract.fields` 設定を追加する

```jsonc
{
  "page_mode": "extract",
  "extract": {
    "item_selector": ".property_unit",
    "fields": [
      { "name": "販売価格", "label": "販売価格" },   // ラベル方式
      { "name": "所在地",   "label": "所在地" },
      { "name": "駅徒歩",   "selector": ".ui-pct--util1" } // セレクタ方式
    ]
  }
}
```

- `name`: 通知に表示するフィールド名 (1..50文字)。
- `selector` / `label` は**どちらか一方を必須** (両方・どちらも無しは 400 `invalid_field`)。
- `fields` は最大12件。`selector` は既存セレクタ同様 HTMLRewriter で作成時に同期検証する。

### 2. 抽出セマンティクス (extractItems, HTMLRewriterストリーミングを維持)

- **selector方式**: アイテム内 (`${itemSelector} ${selector}`) の**最初のマッチ**のサブツリー
  テキストを値とする。
- **label方式**: アイテム内の `dt` / `dd` を走査し、dt のサブツリーテキストを正規化
  (空白・`&nbsp;` 圧縮 + trim) した結果が `label` と完全一致したら、**直後の dd** の
  サブツリーテキスト (同様に正規化) を値とする。アイテム内の最初のマッチ優先。
  正規化後に空になる dt (ダミー行) はラベルとして扱わない。
- 値は正規化後 200 文字で切り詰める。マッチしなかったフィールドは結果から省く。
- 抽出結果は `ExtractedItem.fields: Array<{ name, value }>` (設定順)。

### 3. 通知への配線: FeedItem.summary → Change.diff_preview (opt-in)

- pageItems は `fields` を `名前: 値` の行形式に整形して `FeedItem.summary` に載せる
  (フィールド0件なら null)。
- `processFeedItems` にオプション `summaryAsDiffPreview` (既定 false) を追加し、true の場合
  のみ Change 挿入時に `diff_preview = item.summary` を書く。**pageItems 経由の呼び出しだけ
  が true を渡す**。rss/atom アダプタも summary (description/content) を生成しているが、
  これらの通知挙動は本ADRでは変更しない (summary はHTML断片や長文になり得るため、一般化は
  サニタイズ・上限設計とセットで将来判断する)。
- 通知側 (buildDiscordPayload) は既存の diff_preview 表示 (コードフェンス) をそのまま使い、
  変更しない。

### 4. Source設定の更新API: `PATCH /api/sources/:id`

既存 Source の `config` だけを更新できるようにする (url / type / site_id は変更不可)。
検証は作成時と同一 (type別の許可キー・セレクタ検証)。監査イベント `source.update_config`
を記録する。フィールド設定の追加・セレクタ保守 (ADR-0011 Negative で明記した利用者責務) を、
Source 再作成 (= Monitor/baseline 破棄) なしで行えるようにするために必要。

### 5. UI

Source作成フォーム (新着検知モード) に fields 行エディタ (名前 + ラベル/セレクタ種別 + 値、
行の追加/削除) を追加する。既存Sourceの設定編集UIは本ADRのスコープ外 (PATCH APIで代替)。

## Alternatives

- **通知embedのfields化 (Discord embed fields)**: 見栄えは良いが ChangeSummary / notify 層の
  変更が広がる。diff_preview 再利用が最小。将来の改善候補。
- **値の専用クラス依存 (selector方式のみ)**: SUUMOでは価格しか取れず、ゴール (旧suumo-watcher
  相当の通知) を満たせない。
- **アダプタ層での構造化データ保存 (changes に fields JSON列)**: 'updated' 検知 (フィールド
  hash) に将来必要になる可能性はあるが、v1の通知目的には過剰。ADRで将来課題として記録。

## Consequences

- 一覧監視の通知に任意の属性 (価格等) を含められ、suumo-watcher 廃止の置き換え条件が揃う。
- ラベル方式は dt/dd 構造前提。他のラベルレイアウト (th/td 等) は将来の拡張。
- フィールド値の変化は v1 では検知しない ('updated' 未対応のまま)。フィールドhashによる
  擬似 updated 検知は将来課題 (茶タスク管理)。
