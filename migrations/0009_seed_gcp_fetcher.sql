-- Migration number: 0009 	 2026-10-10
-- GCP Executor (Cloud Run, asia-northeast1) と push 型 HTTP Fetcher 'gcp-http' をシードする。
-- 実行系は src/fetch/registry.ts の 'gcp-http' と対応する。
INSERT OR IGNORE INTO executors (id, kind, name, capabilities, status, created_at, updated_at)
VALUES (
  'gcp',
  'cloud_run',
  'GCP Cloud Run (asia-northeast1)',
  '{"fetch_modes":["http"]}',
  'active',
  '2026-10-10T00:00:00.000Z',
  '2026-10-10T00:00:00.000Z'
);

INSERT OR IGNORE INTO fetchers (id, executor_id, fetch_mode, region, profile, created_at, updated_at)
VALUES (
  'gcp-http',
  'gcp',
  'http',
  'asia-northeast1',
  NULL,
  '2026-10-10T00:00:00.000Z',
  '2026-10-10T00:00:00.000Z'
);
