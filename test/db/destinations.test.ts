import { describe, expect, it } from 'vitest';
import { archiveDestination, createSubscription, getDestination, listMatchingSubscriptions, listSubscriptionsByDestination } from '../../src/db';
import { buildFixture, db } from './helpers';

describe('archiveDestination (ADR-0012: soft delete)', () => {
  it('sets archived_at, discards webhook_url, and deletes dependent subscriptions', async () => {
    const d = db();
    const { destination, site, monitor } = await buildFixture(d);
    await createSubscription(d, { destinationId: destination.id, siteId: site.id, monitorId: monitor.id });

    const archived = await archiveDestination(d, destination.id);
    expect(archived).not.toBeNull();
    expect(archived?.archivedAt).not.toBeNull();
    expect(archived?.webhookUrl).toBe('');

    const subs = await listSubscriptionsByDestination(d, destination.id);
    expect(subs).toHaveLength(0);
  });

  it('is idempotent: re-archiving an already-archived destination does not error and keeps the original archived_at', async () => {
    const d = db();
    const { destination } = await buildFixture(d);

    const first = await archiveDestination(d, destination.id);
    const firstArchivedAt = first?.archivedAt;

    const second = await archiveDestination(d, destination.id);
    expect(second).not.toBeNull();
    expect(second?.archivedAt).toBe(firstArchivedAt);
    expect(second?.webhookUrl).toBe('');
  });

  it('returns null for an unknown destination id', async () => {
    const d = db();
    const result = await archiveDestination(d, 'does-not-exist');
    expect(result).toBeNull();
  });
});

describe('listMatchingSubscriptions excludes archived destinations (ADR-0012)', () => {
  it('does not fan out to a subscription whose destination is archived', async () => {
    const d = db();
    const { destination, site, monitor } = await buildFixture(d);
    // subscription created before archiving; archiveDestination itself deletes subscriptions,
    // so recreate one directly after archiving to simulate a stale/leftover row and verify the
    // JOIN condition (archived_at IS NULL) provides defense independent of the delete-on-archive path.
    await archiveDestination(d, destination.id);
    await createSubscription(d, { destinationId: destination.id, siteId: site.id, monitorId: monitor.id });

    const matches = await listMatchingSubscriptions(d, { siteId: site.id, monitorId: monitor.id, kind: 'new' });
    expect(matches).toHaveLength(0);
  });

  it('still fans out to subscriptions of a non-archived destination', async () => {
    const d = db();
    const { destination, site, monitor } = await buildFixture(d);
    await createSubscription(d, { destinationId: destination.id, siteId: site.id, monitorId: monitor.id });

    const matches = await listMatchingSubscriptions(d, { siteId: site.id, monitorId: monitor.id, kind: 'new' });
    expect(matches).toHaveLength(1);

    const fetchedDestination = await getDestination(d, destination.id);
    expect(fetchedDestination?.archivedAt).toBeNull();
  });
});
