-- Wave3: atomic claim for notify delivery processing.
-- Additive only; earlier migrations are not modified.
--
-- getPendingDelivery (src/db/notifyStore.ts) now performs a conditional UPDATE that
-- moves a delivery from pending/failed (or a stale 'sending') into 'sending' before
-- returning it, so that duplicate/concurrent NOTIFY_QUEUE consumption cannot send the
-- same delivery to Discord twice. claimed_at records when that claim happened, so a
-- claim that never completed (crash between claim and markDelivered/markFailed) can be
-- recognized as stale and retried instead of being stuck forever.

ALTER TABLE deliveries ADD COLUMN claimed_at TEXT;
