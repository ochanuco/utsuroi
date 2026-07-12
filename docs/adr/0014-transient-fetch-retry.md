# ADR-0014: 一過性フェッチ失敗のチェック内リトライ

- **Status**: Proposed
- **Date**: 2026-07-12

## Context

cf-http フェッチャは1チェックにつき1回しか取得を試みない。対象サイトが間欠的に 503 を
返す場合 (WAF・レート制限のゆらぎ)、チェック全体が failed になり、次の再試行は1時間後
(monitor interval) になる。移行元の suumo-watcher は取得を最大3回 (250ms×試行回数の
バックオフ) 再試行しており、同一条件下で高い成功率を保っていた実績がある。

job レベルには deferred (Retry-After 尊重の再スケジュール) が既にあるが、これは
rate_limited 等の「待つべき」失敗のための機構であり、数百msで解消する一過性の 5xx /
ネットワークエラーには粒度が粗い。

## Decision

`runFetchSequence` (src/fetch/policy.ts) に**同一フェッチャのエントリ内リトライ**を追加する。

- 対象の失敗クラス: `http_5xx` / `network_error` のみ。
  - `http_429` は対象外 (Retry-After を尊重する既存の deferred 機構に任せる)。
  - `timeout` は対象外 (リトライするとチェック時間が倍々に伸びるため)。
  - `http_4xx` / `ssrf_blocked` 等の恒久的失敗も対象外。
- 回数・間隔: 初回 + 最大2回 (計3試行)、バックオフは 250ms × 再試行回数 (250ms, 500ms)。
  ハードコード定数とし、設定は設けない (必要になったら FetcherPolicy 拡張を検討)。
- 各再試行も CheckAttempt として記録する (attempt_index が増える)。試行履歴の再現可能性
  (SPEC §8 / ADR-0005) を維持し、リトライで成功したのか一発で成功したのかを事後に追える。
- リトライ消化後も失敗している場合の挙動は従来どおり (shouldProceedToNext → 次フェッチャ
  or 失敗確定)。orderList の攻略計画 (planAttempts) は変更しない — エントリ内リトライは
  maxAttempts の枠を消費しない。
- sleep は注入可能にする (テストで実時間待ちしないため)。

## Consequences

- 間欠 503 環境での job 成功率が上がり、新着検知の遅延 (最大 interval 分) が減る。
- 最悪ケースのチェック時間は約 (フェッチ時間×3 + 750ms) 伸びる。DO の実行時間予算に対して
  許容範囲。
- 恒久的な 503 (完全ブロック) の場合は3試行とも失敗して従来と同じ failed になる。
  リクエスト数は最大3倍になるが、interval が1時間なので対象サイトへの負荷増は軽微。
