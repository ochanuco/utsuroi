import { describe, expect, it } from 'vitest';
import { getTarget, setTargetLastKnownUpdatedAt, upsertTarget } from '../../src/db';
import { buildFixture, db } from './helpers';

describe('targets upsert (UNIQUE(monitor_id, url))', () => {
  it('returns the existing target when the same URL is discovered again (e.g. re-crawled sitemap)', async () => {
    const d = db();
    const { monitor } = await buildFixture(d);

    const first = await upsertTarget(d, { monitorId: monitor.id, url: 'https://example.com/page-2' });
    const second = await upsertTarget(d, { monitorId: monitor.id, url: 'https://example.com/page-2' });

    expect(second.id).toBe(first.id);
    expect(second.firstSeenAt).toBe(first.firstSeenAt);
  });
});

describe('setTargetLastKnownUpdatedAt (high-water mark)', () => {
  it('advances from NULL, refuses to rewind to an older value, and advances to a newer one', async () => {
    const d = db();
    const { monitor } = await buildFixture(d);
    const target = await upsertTarget(d, { monitorId: monitor.id, url: 'https://example.com/wm' });

    // NULL からは常に更新される。
    await setTargetLastKnownUpdatedAt(d, target.id, '2026-07-10T00:00:00.000Z');
    expect((await getTarget(d, target.id))?.lastKnownUpdatedAt).toBe('2026-07-10T00:00:00.000Z');

    // 古い値では巻き戻らない (並行実行の lost update 防止、SQL側の条件付きUPDATE)。
    await setTargetLastKnownUpdatedAt(d, target.id, '2026-07-09T00:00:00.000Z');
    expect((await getTarget(d, target.id))?.lastKnownUpdatedAt).toBe('2026-07-10T00:00:00.000Z');

    // 同値でも更新しない (no-op)。
    await setTargetLastKnownUpdatedAt(d, target.id, '2026-07-10T00:00:00.000Z');
    expect((await getTarget(d, target.id))?.lastKnownUpdatedAt).toBe('2026-07-10T00:00:00.000Z');

    // 新しい値へは前進する。
    await setTargetLastKnownUpdatedAt(d, target.id, '2026-07-11T00:00:00.000Z');
    expect((await getTarget(d, target.id))?.lastKnownUpdatedAt).toBe('2026-07-11T00:00:00.000Z');
  });
});
