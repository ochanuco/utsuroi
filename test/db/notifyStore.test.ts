import { describe, expect, it } from 'vitest';
import {
  archiveDestination,
  createD1NotifyStore,
  createDeliveryIfNew,
  createDestination,
  createMonitor,
  createSite,
  createSource,
  encryptWebhookUrl,
  getDelivery,
  insertChangeIfNew,
  resolveTagLines,
  setChangeTagsIfNull,
  upsertTarget,
  type SourceConfig,
} from '../../src/db';
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

  it('reports threadId as null when the destination has no thread_id (ADR-0019)', async () => {
    const d = db();
    const store = createD1NotifyStore(d, TEST_WEBHOOK_ENC_KEY);
    const { monitor, target, destination } = await buildFixture(d);
    const change = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'updated',
      dedupeKey: 'sha256:notify-thread-null',
    });
    const delivery = await createDeliveryIfNew(d, change.row.id, destination.id);

    const pending = await store.getPendingDelivery(delivery.row.id);
    expect(pending?.threadId).toBeNull();
  });

  it('reports the destination thread_id when set (ADR-0019)', async () => {
    const d = db();
    const store = createD1NotifyStore(d, TEST_WEBHOOK_ENC_KEY);
    const { monitor, target } = await buildFixture(d);
    const encryptedWebhookUrl = await encryptWebhookUrl(FIXTURE_WEBHOOK_URL, 'discord.com/***test', TEST_WEBHOOK_ENC_KEY);
    const destination = await createDestination(d, {
      name: 'Threaded Discord',
      webhookUrl: encryptedWebhookUrl,
      threadId: '123456789012345678',
    });
    const change = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'updated',
      dedupeKey: 'sha256:notify-thread-set',
    });
    const delivery = await createDeliveryIfNew(d, change.row.id, destination.id);

    const pending = await store.getPendingDelivery(delivery.row.id);
    expect(pending?.threadId).toBe('123456789012345678');
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

// labels機能 (ADR-0019): resolveTagLines のグループ化・ラベル解決ロジック単体テスト。
describe('resolveTagLines', () => {
  it('maps a tag to its labeled value', () => {
    const lines = resolveTagLines(['area:kuzuha'], { tags: { 'area:kuzuha': 'くずは' } });
    expect(lines).toEqual([{ heading: '分類', values: ['くずは'] }]);
  });

  it('falls back to the raw tag when no label is mapped', () => {
    const lines = resolveTagLines(['area:kuzuha'], { tags: {} });
    expect(lines).toEqual([{ heading: '分類', values: ['area:kuzuha'] }]);
  });

  it('ignores Object.prototype keys such as constructor', () => {
    const lines = resolveTagLines(['constructor'], { groups: {}, tags: {} });
    expect(lines).toEqual([{ heading: '分類', values: ['constructor'] }]);
  });

  it('falls back to 分類 when the group has no heading mapped', () => {
    const lines = resolveTagLines(['area:kuzuha'], { groups: {}, tags: { 'area:kuzuha': 'くずは' } });
    expect(lines[0]!.heading).toBe('分類');
  });

  it('uses the mapped group heading when present', () => {
    const lines = resolveTagLines(['area:kuzuha'], { groups: { area: 'エリア' }, tags: { 'area:kuzuha': 'くずは' } });
    expect(lines[0]!.heading).toBe('エリア');
  });

  it('orders groups by first appearance and preserves per-group value order', () => {
    const lines = resolveTagLines(
      ['topic:rent', 'area:kuzuha', 'area:central', 'topic:sale'],
      {
        groups: { area: 'エリア', topic: '話題' },
        tags: {
          'area:kuzuha': 'くずは',
          'area:central': '市駅周辺',
          'topic:rent': '賃貸',
          'topic:sale': '売買',
        },
      },
    );
    expect(lines).toEqual([
      { heading: '話題', values: ['賃貸', '売買'] },
      { heading: 'エリア', values: ['くずは', '市駅周辺'] },
    ]);
  });

  it('groups a tag with no colon under the empty-string group key', () => {
    const lines = resolveTagLines(['unclassified'], undefined);
    expect(lines).toEqual([{ heading: '分類', values: ['unclassified'] }]);
  });

  it('returns an empty array for null tags', () => {
    expect(resolveTagLines(null, { tags: { x: 'y' } })).toEqual([]);
  });

  it('returns an empty array for an empty tags array', () => {
    expect(resolveTagLines([], { tags: { x: 'y' } })).toEqual([]);
  });
});

// labels機能 (ADR-0019): getPendingDelivery が Change.tags と Source.config.classify.labels から
// ChangeSummary.tags / tagLines を組み立てることを検証する (DB統合)。
describe('getPendingDelivery: tags / tagLines (labels機能)', () => {
  it('populates tags and tagLines from the source classify.labels config', async () => {
    const d = db();
    const store = createD1NotifyStore(d, TEST_WEBHOOK_ENC_KEY);

    const site = await createSite(d, { name: 'Labels Site' });
    const classify: NonNullable<SourceConfig['classify']> = {
      rules: [{ tag: 'area:kuzuha', match: { field: 'title', pattern: 'x' } }],
      labels: {
        groups: { area: 'エリア' },
        tags: { 'area:kuzuha': 'くずは', 'area:other': 'その他' },
      },
    };
    const source = await createSource(d, {
      siteId: site.id,
      type: 'rss',
      url: 'https://example.com/labels-feed.xml',
      config: { classify },
    });
    const monitor = await createMonitor(d, { siteId: site.id, sourceId: source.id, intervalSeconds: 3600 });
    const target = await upsertTarget(d, { monitorId: monitor.id, url: 'https://example.com/labels-feed.xml' });
    const encryptedWebhookUrl = await encryptWebhookUrl(
      FIXTURE_WEBHOOK_URL,
      'discord.com/***test',
      TEST_WEBHOOK_ENC_KEY,
    );
    const destination = await createDestination(d, { name: 'Labels Discord', webhookUrl: encryptedWebhookUrl });

    const change = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'new',
      dedupeKey: 'sha256:notify-labels-1',
    });
    await setChangeTagsIfNull(d, change.row.id, ['area:kuzuha', 'area:other']);
    const delivery = await createDeliveryIfNew(d, change.row.id, destination.id);

    const pending = await store.getPendingDelivery(delivery.row.id);
    expect(pending?.change.tags).toEqual(['area:kuzuha', 'area:other']);
    expect(pending?.change.tagLines).toEqual([{ heading: 'エリア', values: ['くずは', 'その他'] }]);
  });

  it('has no tag lines when the source has no classify config', async () => {
    const d = db();
    const store = createD1NotifyStore(d, TEST_WEBHOOK_ENC_KEY);
    const { monitor, target, destination } = await buildFixture(d);

    const change = await insertChangeIfNew(d, {
      monitorId: monitor.id,
      targetId: target.id,
      targetUrl: target.url,
      kind: 'updated',
      dedupeKey: 'sha256:notify-no-classify',
    });
    const delivery = await createDeliveryIfNew(d, change.row.id, destination.id);

    const pending = await store.getPendingDelivery(delivery.row.id);
    expect(pending?.change.tags).toBeNull();
    expect(pending?.change.tagLines).toEqual([]);
  });
});
