-- Migration number: 0004 	 2026-07-11
-- MVP で唯一実行可能な Cloudflare HTTP Fetcher をシードする。
-- fetcher_policy_entries.fetcher_id は fetchers(id) への FK を持つため、
-- マスタが空だと Fetcher Policy を一切登録できない (実行レジストリは
-- src/pipeline/fetchTarget.ts の 'cf-http' 分岐と対応)。
INSERT OR IGNORE INTO executors (id, kind, name, capabilities, status, created_at, updated_at)
VALUES (
  'cloudflare',
  'cloudflare',
  'Cloudflare Workers',
  '{"fetch_modes":["http"]}',
  'active',
  '2026-07-11T00:00:00.000Z',
  '2026-07-11T00:00:00.000Z'
);

INSERT OR IGNORE INTO fetchers (id, executor_id, fetch_mode, region, profile, created_at, updated_at)
VALUES (
  'cf-http',
  'cloudflare',
  'http',
  NULL,
  NULL,
  '2026-07-11T00:00:00.000Z',
  '2026-07-11T00:00:00.000Z'
);
