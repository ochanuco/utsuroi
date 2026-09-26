import { describe, expect, it } from 'vitest';
import {
  archiveDestination,
  createDeliveryIfNew,
  createDestination,
  createSubscription,
  getDestination,
  insertChangeIfNew,
  listMatchingSubscriptions,
  listSubscriptionsByDestination,
} from '../../src/db';
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

describe('listMatchingSubscriptions: tag matching (ADR-0019)', () => {
  it('matches a NULL-tag subscription regardless of the change tags passed', async () => {
    const d = db();
    const { destination, site, monitor } = await buildFixture(d);
    await createSubscription(d, { destinationId: destination.id, siteId: site.id, monitorId: monitor.id, tag: null });

    const noTags = await listMatchingSubscriptions(d, { siteId: site.id, monitorId: monitor.id, kind: 'new', tags: [] });
    expect(noTags).toHaveLength(1);

    const withTags = await listMatchingSubscriptions(d, {
      siteId: site.id,
      monitorId: monitor.id,
      kind: 'new',
      tags: ['area:kuzuha'],
    });
    expect(withTags).toHaveLength(1);
  });

  it('matches a tagged subscription only when the change carries that tag', async () => {
    const d = db();
    const { destination, site, monitor } = await buildFixture(d);
    await createSubscription(d, {
      destinationId: destination.id,
      siteId: site.id,
      monitorId: monitor.id,
      tag: 'area:kuzuha',
    });

    const matching = await listMatchingSubscriptions(d, {
      siteId: site.id,
      monitorId: monitor.id,
      kind: 'new',
      tags: ['area:kuzuha'],
    });
    expect(matching).toHaveLength(1);

    const nonMatching = await listMatchingSubscriptions(d, {
      siteId: site.id,
      monitorId: monitor.id,
      kind: 'new',
      tags: ['area:other'],
    });
    expect(nonMatching).toHaveLength(0);

    const untagged = await listMatchingSubscriptions(d, { siteId: site.id, monitorId: monitor.id, kind: 'new' });
    expect(untagged).toHaveLength(0);
  });

  it('reaches multiple subscriptions when a change carries multiple tags', async () => {
    const d = db();
    const { destination, site, monitor } = await buildFixture(d);
    const otherDestination = await createDestination(d, {
      name: 'Other Discord',
      webhookUrl: 'https://discord.com/api/webhooks/multi-tag',
    });
    await createSubscription(d, { destinationId: destination.id, siteId: site.id, monitorId: monitor.id, tag: 'area:kuzuha' });
    await createSubscription(d, {
      destinationId: otherDestination.id,
      siteId: site.id,
      monitorId: monitor.id,
      tag: 'topic:sale',
    });

    const matches = await listMatchingSubscriptions(d, {
      siteId: site.id,
      monitorId: monitor.id,
      kind: 'new',
      tags: ['area:kuzuha', 'topic:sale'],
    });
    expect(matches.map((s) => s.destinationId).sort()).toEqual([destination.id, otherDestination.id].sort());
  });

  it('does not create a duplicate delivery when two matching subscriptions point to the same destination', async () => {
    const d = db();
    const { destination, site, monitor, target } = await buildFixture(d);
    // 同じ destination を複数の tag で購読する構成 (例: "area:kuzuha" と "area:other" の両方を
    // 同じチャンネルへ流したい場合)。fanout はこの destination へ2回 createDeliveryIfNew を
    // 呼ぶことになるが、UNIQUE(change_id, destination_id) により2件目は inserted:false になる。
    await createSubscription(d, { destinationId: destination.id, siteId: site.id, monitorId: monitor.id, tag: 'area:kuzuha' });
    await createSubscription(d, { destinationId: destination.id, siteId: site.id, monitorId: monitor.id, tag: 'topic:sale' });

    const matches = await listMatchingSubscriptions(d, {
      siteId: site.id,
      monitorId: monitor.id,
      kind: 'new',
      tags: ['area:kuzuha', 'topic:sale'],
    });
    expect(matches).toHaveLength(2);

    const change = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'new',
      dedupeKey: 'multi-tag-same-destination',
      detectedAt: new Date().toISOString(),
    });

    const first = await createDeliveryIfNew(d, change.row.id, destination.id);
    const second = await createDeliveryIfNew(d, change.row.id, destination.id);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.row.id).toBe(first.row.id);
  });
});
