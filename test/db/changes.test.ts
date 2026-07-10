import { describe, expect, it } from 'vitest';
import { getChange, insertChangeIfNew, listChangesByMonitor } from '../../src/db';
import { buildFixture, db } from './helpers';

describe('changes idempotency (SPEC §17.7-8)', () => {
  it('inserts a new change once and reports inserted=true', async () => {
    const d = db();
    const { monitor, target } = await buildFixture(d);

    const result = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'updated',
      dedupeKey: 'sha256:abc123',
    });

    expect(result.inserted).toBe(true);
    expect(result.row.monitorId).toBe(monitor.id);
    expect(result.row.dedupeKey).toBe('sha256:abc123');

    const stored = await getChange(d, result.row.id);
    expect(stored).not.toBeNull();
  });

  it('ignores a duplicate (monitor_id, dedupe_key) and returns the existing row (page change replay)', async () => {
    const d = db();
    const { monitor, target } = await buildFixture(d);

    const first = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'updated',
      dedupeKey: 'sha256:dup',
      title: 'first attempt',
    });
    expect(first.inserted).toBe(true);

    // simulate the same Check Job re-running and re-detecting the same content hash
    const second = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'updated',
      dedupeKey: 'sha256:dup',
      title: 'second attempt (should be ignored)',
    });

    expect(second.inserted).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.title).toBe('first attempt');

    const all = await listChangesByMonitor(d, monitor.id);
    expect(all.filter((c) => c.dedupeKey === 'sha256:dup')).toHaveLength(1);
  });

  it('allows the same dedupe_key across different monitors (RSS entry replay across feeds)', async () => {
    const d = db();
    const fixtureA = await buildFixture(d, { siteName: 'Site A' });
    const fixtureB = await buildFixture(d, { siteName: 'Site B' });

    const a = await insertChangeIfNew(d, {
      monitorId: fixtureA.monitor.id,
      targetId: fixtureA.target.id,
      targetUrl: fixtureA.target.url,
      kind: 'new',
      dedupeKey: 'stable-key:shared-guid',
    });
    const b = await insertChangeIfNew(d, {
      monitorId: fixtureB.monitor.id,
      targetId: fixtureB.target.id,
      targetUrl: fixtureB.target.url,
      kind: 'new',
      dedupeKey: 'stable-key:shared-guid',
    });

    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(true);
    expect(a.row.id).not.toBe(b.row.id);
  });
});
