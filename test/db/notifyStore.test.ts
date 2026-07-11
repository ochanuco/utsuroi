import { describe, expect, it } from 'vitest';
import { archiveDestination, createD1NotifyStore, createDeliveryIfNew, getDelivery, insertChangeIfNew } from '../../src/db';
import { buildFixture, db, FIXTURE_WEBHOOK_URL, TEST_WEBHOOK_ENC_KEY } from './helpers';

describe('createD1NotifyStore (implements src/shared/contracts.ts NotifyStore)', () => {
  it('unknown delivery id returns null', async () => {
    const store = createD1NotifyStore(db(), TEST_WEBHOOK_ENC_KEY);
    await expect(store.getPendingDelivery('does-not-exist')).resolves.toBeNull();
  });

  it('getPendingDelivery -> markDelivered -> re-fetch returns null (idempotent consumption)', async () => {
    const d = db();
    const store = createD1NotifyStore(d, TEST_WEBHOOK_ENC_KEY);
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
    // destination.webhookUrl is the encrypted-at-rest envelope; getPendingDelivery decrypts
    // it back to the plaintext webhook URL that was originally encrypted in buildFixture().
    expect(pending?.webhookUrl).toBe(FIXTURE_WEBHOOK_URL);
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
    const store = createD1NotifyStore(d, TEST_WEBHOOK_ENC_KEY);
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
    const store = createD1NotifyStore(d, TEST_WEBHOOK_ENC_KEY);
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

  it('does not claim (transition to sending) a delivery when WEBHOOK_ENC_KEY is missing', async () => {
    const d = db();
    const store = createD1NotifyStore(d, undefined);
    const { monitor, target, destination } = await buildFixture(d);
    const change = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'updated',
      dedupeKey: 'sha256:notify-enc-key-missing',
    });
    const delivery = await createDeliveryIfNew(d, change.row.id, destination.id);

    await expect(store.getPendingDelivery(delivery.row.id)).rejects.toThrow(/WEBHOOK_ENC_KEY/);

    // claim (UPDATE ... SET status = 'sending') must not have run: the delivery should still
    // be 'pending' so that a later call (once the key is configured) can still claim it.
    const row = await getDelivery(d, delivery.row.id);
    expect(row?.status).toBe('pending');
  });

  it('marks a delivery dead (without attempting decryption) and returns null when its destination was archived after enqueue (ADR-0012)', async () => {
    const d = db();
    const store = createD1NotifyStore(d, TEST_WEBHOOK_ENC_KEY);
    const { monitor, target, destination } = await buildFixture(d);
    const change = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'updated',
      dedupeKey: 'sha256:notify-archived',
    });
    const delivery = await createDeliveryIfNew(d, change.row.id, destination.id);

    // アーカイブ前に enqueue 済みだったケースを模す (webhook_url は既に破棄されている)。
    await archiveDestination(d, destination.id);

    const pending = await store.getPendingDelivery(delivery.row.id);
    expect(pending).toBeNull();

    const row = await getDelivery(d, delivery.row.id);
    expect(row?.status).toBe('dead');
    expect(row?.lastError).toBe('destination archived');
  });

  it('atomically claims a delivery: a second concurrent getPendingDelivery call sees it as already claimed', async () => {
    const d = db();
    const store = createD1NotifyStore(d, TEST_WEBHOOK_ENC_KEY);
    const { monitor, target, destination } = await buildFixture(d);
    const change = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'updated',
      dedupeKey: 'sha256:notify-4',
    });
    const delivery = await createDeliveryIfNew(d, change.row.id, destination.id);

    // 1つ目の呼び出しが claim (pending -> sending) に成功する。
    const first = await store.getPendingDelivery(delivery.row.id);
    expect(first).not.toBeNull();

    // 同じ delivery を指す2つ目の呼び出し (重複キューメッセージ・同時実行を模す) は
    // status が既に 'sending' (かつ stale ではない) なので claim できず null を返す。
    // これにより Discord への二重送信を防ぐ。
    const second = await store.getPendingDelivery(delivery.row.id);
    expect(second).toBeNull();
  });
});
