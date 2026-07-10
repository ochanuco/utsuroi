# Utsuroi Roadmap

- **文書状態**: Directional
- **更新日**: 2026-07-10

## 1. 現在のプロダクト境界

初期フェーズでは、UtsuroiをWeb変更検知システムとして提供する。

```text
Web Source
  -> Acquire
  -> Normalize / Compare
  -> Decide
  -> Discord Deliver
```

汎用タスクスケジューラ、任意コード実行、DAGワークフローは初期フェーズの対象外とする。

## 2. 将来像

将来的には、外部リソースやイベントを取得し、内容と状態を分析し、ポリシーに基づいて適切なDestinationへ配信または作用する基盤へ拡張する。

```text
Acquire -> Analyze -> Decide -> Deliver
```

目標は、単なる定期実行ではなく、履歴、重要度、失敗分類、コスト、実行環境の状態に応じて実行計画を変えられるアダプティブな情報処理基盤である。

## 3. フェーズ

### Phase 0: Web Change Detection MVP

- Page、RSS/Atom、Sitemap
- HTTP / Browser Fetch
- Cloudflare / Home Runner
- Fetcher AllowList / OrderList
- robots.txt Policy
- DOM/Text差分
- Discord通知
- 履歴と差分UI

### Phase 1: Web監視の高度化

- Cloud Run Runner
- 地域別Executor
- semantic change classification
- 通知要約
- selector提案
- Fetcher成功率・コストの可視化
- OrderList変更の推奨
- 日次・週次Digest

この段階では、AllowListへの自動追加やOrderListの無断変更は行わない。

### Phase 2: ConnectorとProcessorの抽象化

Web監視の内部構造から、以下の共通境界を抽出する。

- Trigger
- Source / Connector
- Processor
- Policy
- Action / Destination
- Run / Attempt
- State

UIは引き続きユースケース別に提供し、汎用ワークフロー編集画面を先に作らない。

### Phase 3: Gmail分類とDiscord通知

想定フロー:

```text
Gmail Pub/Sub
  -> Message Fetch
  -> Rule Filter
  -> Classification
  -> Discord Notify
  -> Label / Archive / Delayed Trash
```

必要な基盤機能:

- Event Trigger
- OAuthとSecret管理
- Message単位の冪等性
- 分類信頼度
- 副作用の段階実行
- 保留期間
- 手動承認
- 監査ログ
- 失敗時の安全側停止

削除系Actionは、分類直後に実行せず、Label、保留、再確認を経由する。

### Phase 4: 外部イベントの集約

候補:

- GitHub通知
- API監視
- ニュース・RSS集約
- カレンダー・Webhookイベント
- Discordへの即時通知、Digest、Thread集約

### Phase 5: Adaptive Information Orchestration

状況に応じたExecution Planを生成する。

```text
Context
  -> Policy Engine
  -> Execution Plan
  -> Run
  -> Feedback
```

Execution Planの候補要素:

- selected_fetcher
- selected_executor
- analysis_depth
- retry_strategy
- delivery_mode
- next_schedule
- cost_budget
- approval_requirement

初期は推奨のみを提示し、明示ルール、承認付き変更、限定的自動化の順で導入する。

## 4. 設計上のガードレール

- 初期仕様へ将来機能を混在させない。
- 現在のUIではWeb監視用語を維持する。
- 内部抽象化は実際に2つ目のユースケースが必要になるまで最小限とする。
- 任意コード実行を安易に許可しない。
- 副作用を伴うActionは冪等性、監査、承認、取消可能性を持たせる。
- AI判定だけを根拠に破壊的Actionを実行しない。
- 自動最適化は説明可能で、設定された許可境界を越えない。
- コスト上限と実行回数上限をPolicyに含める。

## 5. 到達点の定義

Utsuroiの長期的な到達点は、次のように定義する。

> 外部世界の変化を取得し、文脈と状態を分析し、明示されたポリシーと許可境界の中で、適切な経路・粒度・タイミングにより配信または作用するシステム。

これは方向性を示すものであり、現行仕様の実装要件ではない。
