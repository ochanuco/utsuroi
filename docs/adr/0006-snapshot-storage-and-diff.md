# ADR-0006: 本文はR2、索引はD1、差分は決定論的処理を優先する

- **Status**: Accepted
- **Date**: 2026-07-10

## Context

HTML本文と差分は容量が増えやすく、Durable Object storageやD1へ直接蓄積する用途に適さない。意味的判定だけでは再現性とコスト管理が難しい。

## Decision

- raw/normalized bodyと差分artifactはR2へ保存する。
- 索引、状態、ハッシュ、実行履歴はD1へ保存する。
- ハッシュ、正規化DOM、抽出テキスト、構造差分を先に評価する。
- semantic classificationは変更候補への後段処理とする。

## Consequences

- 本文保存を安価に拡張できる。
- 正規化バージョンとRetention管理が必要になる。
