import { describe, expect, it } from 'vitest';
import { upsertTarget } from '../../src/db';
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
