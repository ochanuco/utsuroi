import { describe, expect, it } from 'vitest';
import {
  createDeliveryIfNew,
  getDelivery,
  insertChangeIfNew,
  listDeliveriesByChange,
  markDeliveryDelivered,
  markDeliveryFailed,
} from '../../src/db';
import { buildFixture, db } from './helpers';

describe('deliveries idempotency (ADR-0007: UNIQUE(change_id, destination_id))', () => {
  it('creates a pending delivery once per (change, destination) pair', async () => {
    const d = db();
    const { monitor, target, destination } = await buildFixture(d);
    const change = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'updated',
      dedupeKey: 'sha256:x',
    });

    const first = await createDeliveryIfNew(d, change.row.id, destination.id);
    expect(first.inserted).toBe(true);
    expect(first.row.status).toBe('pending');

    // Queue re-delivery / at-least-once redelivery of the same message
    const second = await createDeliveryIfNew(d, change.row.id, destination.id);
    expect(second.inserted).toBe(false);
    expect(second.row.id).toBe(first.row.id);

    const all = await listDeliveriesByChange(d, change.row.id);
    expect(all).toHaveLength(1);
  });

  it('does not resurrect a delivered/failed delivery on re-creation attempts', async () => {
    const d = db();
    const { monitor, target, destination } = await buildFixture(d);
    const change = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'updated',
      dedupeKey: 'sha256:y',
    });

    const created = await createDeliveryIfNew(d, change.row.id, destination.id);
    await markDeliveryDelivered(d, created.row.id);

    const again = await createDeliveryIfNew(d, change.row.id, destination.id);
    expect(again.inserted).toBe(false);
    expect(again.row.status).toBe('delivered');

    const fetched = await getDelivery(d, created.row.id);
    expect(fetched?.status).toBe('delivered');
    expect(fetched?.deliveredAt).not.toBeNull();
  });

  it('marks failures with attempt_count increment and dead status when opts.dead=true', async () => {
    const d = db();
    const { monitor, target, destination } = await buildFixture(d);
    const change = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'updated',
      dedupeKey: 'sha256:z',
    });
    const created = await createDeliveryIfNew(d, change.row.id, destination.id);

    await markDeliveryFailed(d, created.row.id, '429 rate limited', { dead: false });
    let fetched = await getDelivery(d, created.row.id);
    expect(fetched?.status).toBe('failed');
    expect(fetched?.attemptCount).toBe(1);
    expect(fetched?.lastError).toBe('429 rate limited');

    await markDeliveryFailed(d, created.row.id, 'giving up', { dead: true });
    fetched = await getDelivery(d, created.row.id);
    expect(fetched?.status).toBe('dead');
    expect(fetched?.attemptCount).toBe(2);
  });
});
