-- Utsuroi D1 schema (SPEC.md §13, ADR-0006/0007/0008/0009)
-- id: TEXT (UUID), timestamps: TEXT (ISO 8601)

-- ---------------------------------------------------------------------------
-- sites / sources / monitors
-- ---------------------------------------------------------------------------

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  primary_origin TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  type TEXT NOT NULL, -- SourceType: page | rss | atom | sitemap | sitemap-index
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_sources_site_id ON sources(site_id);

CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  status TEXT NOT NULL, -- MonitorStatus
  stop_reason TEXT,
  robots_evaluation_id TEXT REFERENCES robots_evaluations(id),
  interval_seconds INTEGER NOT NULL,
  next_run_at TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_monitors_site_id ON monitors(site_id);
CREATE INDEX idx_monitors_source_id ON monitors(source_id);
CREATE INDEX idx_monitors_status ON monitors(status);
CREATE INDEX idx_monitors_next_run_at ON monitors(next_run_at);

-- ---------------------------------------------------------------------------
-- fetchers / fetcher policy (SPEC §8, ADR-0005)
-- ---------------------------------------------------------------------------

CREATE TABLE executors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL, -- 'cloudflare' | 'home_runner' | 'cloud_run' | ...
  name TEXT NOT NULL,
  capabilities TEXT, -- JSON: supported fetch modes etc.
  status TEXT NOT NULL DEFAULT 'active', -- maintenance state
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE fetchers (
  id TEXT PRIMARY KEY, -- logical fetcher id, e.g. 'cf-http-apac'
  executor_id TEXT NOT NULL REFERENCES executors(id),
  fetch_mode TEXT NOT NULL, -- 'http' | 'browser'
  region TEXT,
  profile TEXT, -- JSON: network/UA profile
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_fetchers_executor_id ON fetchers(executor_id);

-- One Fetcher Policy per site. AllowList/OrderList are represented by the
-- entries table: membership == AllowList, order_index == OrderList position.
-- This makes "every AllowList fetcher appears in OrderList exactly once" true
-- by construction (SPEC §8 invariants 1-2).
CREATE TABLE fetcher_policies (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL UNIQUE REFERENCES sites(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE fetcher_policy_entries (
  id TEXT PRIMARY KEY,
  fetcher_policy_id TEXT NOT NULL REFERENCES fetcher_policies(id),
  fetcher_id TEXT NOT NULL REFERENCES fetchers(id),
  order_index INTEGER NOT NULL,
  proceed_on TEXT, -- JSON array of FailureClass, null = DEFAULT_PROCEEDABLE_FAILURES
  UNIQUE(fetcher_policy_id, fetcher_id),
  UNIQUE(fetcher_policy_id, order_index)
);

CREATE INDEX idx_fetcher_policy_entries_policy_id ON fetcher_policy_entries(fetcher_policy_id);

-- ---------------------------------------------------------------------------
-- targets / check jobs / check attempts
-- ---------------------------------------------------------------------------

CREATE TABLE targets (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id),
  url TEXT NOT NULL,
  discovered_from TEXT, -- stable_key of the feed/sitemap entry that discovered it
  first_seen_at TEXT NOT NULL,
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(monitor_id, url)
);

CREATE INDEX idx_targets_monitor_id ON targets(monitor_id);

CREATE TABLE check_jobs (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id),
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL, -- CheckJobStatus
  trigger TEXT NOT NULL DEFAULT 'scheduled', -- 'scheduled' | 'manual' | 'reconciliation'
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(monitor_id, scheduled_for)
);

CREATE INDEX idx_check_jobs_monitor_id ON check_jobs(monitor_id);
CREATE INDEX idx_check_jobs_status ON check_jobs(status);

CREATE TABLE check_attempts (
  id TEXT PRIMARY KEY,
  check_job_id TEXT NOT NULL REFERENCES check_jobs(id),
  target_id TEXT NOT NULL REFERENCES targets(id),
  fetcher_id TEXT NOT NULL REFERENCES fetchers(id),
  attempt_index INTEGER NOT NULL,
  outcome TEXT NOT NULL, -- 'success' | 'failure'
  failure_class TEXT, -- FailureClass
  status_code INTEGER,
  duration_ms INTEGER,
  snapshot_id TEXT REFERENCES snapshots(id),
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_check_attempts_job_id ON check_attempts(check_job_id);
CREATE INDEX idx_check_attempts_target_id ON check_attempts(target_id);
CREATE INDEX idx_check_attempts_fetcher_id ON check_attempts(fetcher_id);

-- ---------------------------------------------------------------------------
-- snapshots (R2 content-addressed metadata, ADR-0006)
-- ---------------------------------------------------------------------------

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id),
  target_id TEXT NOT NULL REFERENCES targets(id),
  check_attempt_id TEXT REFERENCES check_attempts(id),
  fetched_at TEXT NOT NULL,
  http_status INTEGER,
  content_type TEXT,
  etag TEXT,
  last_modified TEXT,
  body_hash TEXT, -- sha256 hex of raw body; also the R2 content-addressed key
  r2_key TEXT, -- raw body R2 key
  normalized_hash TEXT, -- sha256 hex of normalized DOM
  normalized_r2_key TEXT, -- normalized body R2 key
  text_hash TEXT, -- sha256 hex of extracted text
  normalization_version INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_snapshots_monitor_id ON snapshots(monitor_id);
CREATE INDEX idx_snapshots_target_id ON snapshots(target_id);
CREATE INDEX idx_snapshots_body_hash ON snapshots(body_hash);

-- ---------------------------------------------------------------------------
-- changes (idempotent via UNIQUE(monitor_id, dedupe_key), SPEC §17.7-8)
-- ---------------------------------------------------------------------------

CREATE TABLE changes (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id),
  target_id TEXT REFERENCES targets(id),
  target_url TEXT NOT NULL,
  kind TEXT NOT NULL, -- ChangeKind: new | updated | removed
  diff_level TEXT, -- DiffLevel
  dedupe_key TEXT NOT NULL, -- page: content-hash derived; feed: stable_key derived
  previous_snapshot_id TEXT REFERENCES snapshots(id),
  snapshot_id TEXT REFERENCES snapshots(id),
  diff_r2_key TEXT, -- full unified diff artifact in R2
  diff_preview TEXT, -- truncated preview for notifications (ChangeSummary.diffPreview)
  title TEXT,
  detected_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(monitor_id, dedupe_key)
);

CREATE INDEX idx_changes_monitor_id ON changes(monitor_id);
CREATE INDEX idx_changes_detected_at ON changes(detected_at);

-- ---------------------------------------------------------------------------
-- destinations / subscriptions / deliveries (SPEC §14, ADR-0007)
-- ---------------------------------------------------------------------------

CREATE TABLE destinations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL REFERENCES destinations(id),
  site_id TEXT REFERENCES sites(id),
  monitor_id TEXT REFERENCES monitors(id),
  tag TEXT,
  change_kind TEXT, -- optional ChangeKind filter
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_subscriptions_destination_id ON subscriptions(destination_id);
CREATE INDEX idx_subscriptions_site_id ON subscriptions(site_id);
CREATE INDEX idx_subscriptions_monitor_id ON subscriptions(monitor_id);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES changes(id),
  destination_id TEXT NOT NULL REFERENCES destinations(id),
  status TEXT NOT NULL, -- DeliveryStatus: pending | delivered | failed | dead
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(change_id, destination_id)
);

CREATE INDEX idx_deliveries_status ON deliveries(status);
CREATE INDEX idx_deliveries_change_id ON deliveries(change_id);

-- ---------------------------------------------------------------------------
-- robots.txt (SPEC §9, ADR-0008/0009)
-- ---------------------------------------------------------------------------

CREATE TABLE robots_policies (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  canonical_origin TEXT NOT NULL,
  mode TEXT NOT NULL, -- RobotsMode: enforce | ignore
  reason TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(site_id, canonical_origin)
);

CREATE TABLE robots_evaluations (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL, -- canonical origin
  verdict TEXT NOT NULL, -- RobotsVerdict: allowed | disallowed
  robots_url TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  user_agent_group TEXT NOT NULL,
  matched_rule TEXT,
  unavailable INTEGER NOT NULL DEFAULT 0,
  robots_would_block INTEGER NOT NULL DEFAULT 0, -- Override(ignore) bookkeeping, ADR-0009
  robots_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_robots_evaluations_origin ON robots_evaluations(origin, checked_at);

-- ---------------------------------------------------------------------------
-- audit_events (append-only, ADR-0009)
-- ---------------------------------------------------------------------------

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  reason TEXT,
  payload TEXT, -- JSON
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_events_subject ON audit_events(subject);
CREATE INDEX idx_audit_events_created_at ON audit_events(created_at);
