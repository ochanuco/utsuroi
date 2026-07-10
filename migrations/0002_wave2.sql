-- Wave2 additions: pipeline (src/pipeline) + Durable Object boundaries (src/do).
-- Additive only; migrations/0001_init.sql is not modified.

-- ---------------------------------------------------------------------------
-- robots.txt cache (backs the RobotsCache interface consumed by checkRobots,
-- SPEC §9). Keyed by canonical origin. `rules` stores the parsed RobotsRules
-- as JSON so checkRobots's TTL logic (src/robots/check.ts) can rehydrate a
-- CachedRobots entry without re-fetching robots.txt on every check.
-- ---------------------------------------------------------------------------

CREATE TABLE robots_cache (
  origin TEXT PRIMARY KEY,
  robots_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  unavailable INTEGER NOT NULL DEFAULT 0,
  rules TEXT, -- JSON: RobotsRules (groups + sitemaps), null when unavailable
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- sources.config: optional per-source JSON config (normalize ignore/include
-- selectors etc, SPEC §12). Additive nullable column; existing rows default
-- to NULL (normalizeHtml falls back to its own defaults).
-- ---------------------------------------------------------------------------

ALTER TABLE sources ADD COLUMN config TEXT;
