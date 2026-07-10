import { describe, expect, it } from 'vitest';
import { createD1NotifyStore, createDeliveryIfNew, insertChangeIfNew } from '../../src/db';
import { buildFixture, db } from './helpers';

describe('createD1NotifyStore (implements src/shared/contracts.ts NotifyStore)', () => {
  it('unknown delivery id returns null', async () => {
    const store = createD1NotifyStore(db());
    await expect(store.getPendingDelivery('does-not-exist')).resolves.toBeNull();
  });

  it('getPendingDelivery -> markDelivered -> re-fetch returns null (idempotent consumption)', async () => {
    const d = db();
    const store = createD1NotifyStore(d);
    const { monitor, site, source, target, destination } = await buildFixture(d);

    const change = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'updated',
      dedupeKey: 'sha256:notify-1',
      title: 'Homepage changed',
      diffPreview: '+ added line\n- removed line',
    });
    const delivery = await createDeliveryIfNew(d, change.row.id, destination.id);

    const pending = await store.getPendingDelivery(delivery.row.id);
    expect(pending).not.toBeNull();
    expect(pending?.webhookUrl).toBe(destination.webhookUrl);
    expect(pending?.attemptCount).toBe(0);
    expect(pending?.change).toMatchObject({
      changeId: change.row.id,
      kind: 'updated',
      sourceType: source.type,
      siteName: site.name,
      monitorId: monitor.id,
      targetUrl: target.url,
      title: 'Homepage changed',
      diffPreview: '+ added line\n- removed line',
    });

    await store.markDelivered(delivery.row.id);

    const afterDelivered = await store.getPendingDelivery(delivery.row.id);
    expect(afterDelivered).toBeNull();
  });

  it('a dead delivery is also treated as terminal (returns null)', async () => {
    const d = db();
    const store = createD1NotifyStore(d);
    const { monitor, target, destination } = await buildFixture(d);
    const change = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'updated',
      dedupeKey: 'sha256:notify-2',
    });
    const delivery = await createDeliveryIfNew(d, change.row.id, destination.id);

    await store.markFailed(delivery.row.id, 'permanent failure', { dead: true });
    await expect(store.getPendingDelivery(delivery.row.id)).resolves.toBeNull();
  });

  it('a failed (non-dead) delivery is still returned as a retry candidate', async () => {
    const d = db();
    const store = createD1NotifyStore(d);
    const { monitor, target, destination } = await buildFixture(d);
    const change = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'updated',
      dedupeKey: 'sha256:notify-3',
    });
    const delivery = await createDeliveryIfNew(d, change.row.id, destination.id);

    await store.markFailed(delivery.row.id, 'transient 500', { dead: false });
    const retryCandidate = await store.getPendingDelivery(delivery.row.id);
    expect(retryCandidate).not.toBeNull();
    expect(retryCandidate?.attemptCount).toBe(1);
  });
});
