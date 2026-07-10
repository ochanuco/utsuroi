import { describe, expect, it } from 'vitest';
import { db } from './helpers';

const EXPECTED_TABLES = [
  'sites',
  'sources',
  'monitors',
  'fetchers',
  'fetcher_policies',
  'fetcher_policy_entries',
  'executors',
  'targets',
  'check_jobs',
  'check_attempts',
  'snapshots',
  'changes',
  'destinations',
  'subscriptions',
  'deliveries',
  'robots_policies',
  'robots_evaluations',
  'audit_events',
];

describe('schema (migrations/0001_init.sql)', () => {
  it('creates every table required by SPEC §13', async () => {
    const { results } = await db()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all<{ name: string }>();
    const tableNames = new Set(results.map((r) => r.name));

    for (const table of EXPECTED_TABLES) {
      expect(tableNames.has(table), `missing table: ${table}`).toBe(true);
    }
  });

  it('enforces UNIQUE(monitor_id, dedupe_key) on changes at the schema level', async () => {
    const { results } = await db()
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'changes'`)
      .all<{ sql: string }>();
    expect(results[0]?.sql).toMatch(/UNIQUE\s*\(\s*monitor_id\s*,\s*dedupe_key\s*\)/i);
  });

  it('enforces UNIQUE(change_id, destination_id) on deliveries at the schema level', async () => {
    const { results } = await db()
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'`)
      .all<{ sql: string }>();
    expect(results[0]?.sql).toMatch(/UNIQUE\s*\(\s*change_id\s*,\s*destination_id\s*\)/i);
  });

  it('enforces UNIQUE(monitor_id, scheduled_for) on check_jobs at the schema level', async () => {
    const { results } = await db()
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'check_jobs'`)
      .all<{ sql: string }>();
    expect(results[0]?.sql).toMatch(/UNIQUE\s*\(\s*monitor_id\s*,\s*scheduled_for\s*\)/i);
  });

  it('enforces UNIQUE(site_id, canonical_origin) on robots_policies at the schema level', async () => {
    const { results } = await db()
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'robots_policies'`)
      .all<{ sql: string }>();
    expect(results[0]?.sql).toMatch(/UNIQUE\s*\(\s*site_id\s*,\s*canonical_origin\s*\)/i);
  });
});
