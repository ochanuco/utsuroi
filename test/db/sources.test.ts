import { describe, expect, it } from 'vitest';
import { countMonitorsBySource, createMonitor, createSite, createSource, deleteSource, getSource } from '../../src/db';
import { db } from './helpers';

describe('deleteSource / countMonitorsBySource (Source削除機能)', () => {
  it('deletes the source row', async () => {
    const d = db();
    const site = await createSite(d, { name: 'Delete Source Site' });
    const source = await createSource(d, { siteId: site.id, type: 'page', url: 'https://delete-me.example/' });

    const deleted = await deleteSource(d, source.id);
    expect(deleted).toBe(true);
    expect(await getSource(d, source.id)).toBeNull();
  });

  it('returns false and changes nothing for an unknown source id', async () => {
    const d = db();
    expect(await deleteSource(d, 'does-not-exist')).toBe(false);
  });

  it('counts monitors referencing a source (used by the API layer 409 guard)', async () => {
    const d = db();
    const site = await createSite(d, { name: 'Count Monitors Site' });
    const source = await createSource(d, { siteId: site.id, type: 'page', url: 'https://count.example/' });
    expect(await countMonitorsBySource(d, source.id)).toBe(0);

    await createMonitor(d, { siteId: site.id, sourceId: source.id, intervalSeconds: 3600 });
    expect(await countMonitorsBySource(d, source.id)).toBe(1);
  });
});
