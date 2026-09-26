-- ADR-0019: タグベース通知ルーティング (Classify段 と Destination.thread_id)。
-- changes.tags: JSON配列 (文字列)。NULL=未分類 (Classify段が未実行/未設定)、
-- []=分類済みだがタグ無し (どのルールにも一致せず default_tag も未設定)。
-- destinations.thread_id: 設定時、配送先 Discord Webhook URL に ?thread_id= を付けて送る。
ALTER TABLE changes ADD COLUMN tags TEXT;
ALTER TABLE destinations ADD COLUMN thread_id TEXT;
