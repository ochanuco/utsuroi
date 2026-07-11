-- Migration number: 0006 	 2026-07-12
-- ADR-0012: Destination のアーカイブ (soft delete)。
-- 配送履歴のある destination は deliveries.destination_id の FOREIGN KEY 制約により
-- 物理削除できない (migrations/0001_init.sql)。代替として archived_at を追加し、
-- POST /api/destinations/:id/archive で論理削除する。

ALTER TABLE destinations ADD COLUMN archived_at TEXT;
