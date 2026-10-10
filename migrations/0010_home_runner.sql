-- Migration number: 0010 	 2026-10-11
-- Home Runner (宅内, pull 型) の Executor と HTTP Fetcher 'home-http' をシードし、
-- check_attempts に pull 型 Executor の job id を記録する列を足す (ADR-0023 §8)。
-- 実行系は src/fetch/registry.ts の 'home-http' と対応する。Site の AllowList に追加するまでは使われない。
INSERT OR IGNORE INTO executors (id, kind, name, capabilities, status, created_at, updated_at)
VALUES (
  'home',
  'home_runner',
  'Home Runner',
  '{"fetch_modes":["http"]}',
  'active',
  '2026-10-11T00:00:00.000Z',
  '2026-10-11T00:00:00.000Z'
);

INSERT OR IGNORE INTO fetchers (id, executor_id, fetch_mode, region, profile, created_at, updated_at)
VALUES (
  'home-http',
  'home',
  'http',
  NULL,
  NULL,
  '2026-10-11T00:00:00.000Z',
  '2026-10-11T00:00:00.000Z'
);

ALTER TABLE check_attempts ADD COLUMN executor_job_id TEXT;
