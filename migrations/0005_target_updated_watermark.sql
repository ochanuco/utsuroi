-- Wave5: per-Target "last known updatedAt" watermark for feed/sitemap items.
-- Additive only; earlier migrations are not modified.
--
-- Fixes a latent gap in the feed baseline fix (src/pipeline/feed.ts): without a
-- persisted watermark, the 'updated' Change dedupe key (`${stableKey}:${updatedAt}`)
-- had never been recorded during the baseline check (which intentionally creates no
-- Change rows), so the *first* non-baseline check of a sitemap where every URL still
-- carries the same (unchanged) <lastmod> would see every dedupeKey as "never seen
-- before" and fire an 'updated' Change for every URL - reproducing the same mass
-- notification failure mode the baseline fix was meant to prevent, just one check
-- later. Recording the observed updatedAt on the Target row itself lets
-- processFeedItems compare against the last known value directly, independent of
-- whether a Change row was ever inserted for it.

ALTER TABLE targets ADD COLUMN last_known_updated_at TEXT;
