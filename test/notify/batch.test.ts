import { describe, expect, it } from 'vitest';
import { processNotifyBatch } from '../../src/notify/batch';
import type { NotifyMessageBatch } from '../../src/notify/batch';
import type { ChangeSummary, PendingDelivery } from '../../src/shared/contracts';
import { FakeNotifyStore, makeMessage } from './fake-store';

const WEBHOOK_URL = 'https://discord.com/api/webhooks/999999999999999999/topSecretToken1234';

function makeChange(overrides: Partial<ChangeSummary> = {}): ChangeSummary {
  return {
    changeId: 'change-1',
    kind: 'updated',
    sourceType: 'page',
    siteName: 'Example Site',
    monitorId: 'monitor-1',
    targetUrl: 'https://example.com/page',
    title: 'Example Page',
    detectedAt: '2026-07-10T12:00:00.000Z',
    diffPreview: null,
    ...overrides,
  };
}

function makeDelivery(overrides: Partial<PendingDelivery> = {}): PendingDelivery {
  return {
    deliveryId: 'delivery-1',
    change: makeChange(),
    webhookUrl: WEBHOOK_URL,
    attemptCount: 0,
    ...overrides,
  };
}

function batchOf(...messages: ReturnType<typeof makeMessage>[]): NotifyMessageBatch {
  return { messages } as NotifyMessageBatch;
}

describe('processNotifyBatch', () => {
  it('acks and marks delivered on a successful send', async () => {
    const store = new FakeNotifyStore();
    store.seed(makeDelivery());
    const message = makeMessage({ deliveryId: 'delivery-1' });
    const fetchStub = async () => new Response(null, { status: 204 });

    await processNotifyBatch(batchOf(message), store, { fetch: fetchStub });

    expect(message.ackCount).toBe(1);
    expect(message.retryCalls.length).toBe(0);
    expect(store.statusOf('delivery-1')).toBe('delivered');
  });

  it('acks without sending when the delivery is unknown (idempotent skip)', async () => {
    const store = new FakeNotifyStore();
    const message = makeMessage({ deliveryId: 'missing-delivery' });
    let fetchCalled = false;
    const fetchStub = async () => {
      fetchCalled = true;
      return new Response(null, { status: 204 });
    };

    await processNotifyBatch(batchOf(message), store, { fetch: fetchStub });

    expect(fetchCalled).toBe(false);
    expect(message.ackCount).toBe(1);
    expect(message.retryCalls.length).toBe(0);
  });

  it('acks without sending when the delivery is already delivered (idempotent skip)', async () => {
    const store = new FakeNotifyStore();
    store.seed(makeDelivery());
    await store.markDelivered('delivery-1');
    const message = makeMessage({ deliveryId: 'delivery-1' });
    let fetchCalled = false;
    const fetchStub = async () => {
      fetchCalled = true;
      return new Response(null, { status: 204 });
    };

    await processNotifyBatch(batchOf(message), store, { fetch: fetchStub });

    expect(fetchCalled).toBe(false);
    expect(message.ackCount).toBe(1);
  });

  it('retries respecting Retry-After on 429 without marking the delivery failed', async () => {
    const store = new FakeNotifyStore();
    store.seed(makeDelivery());
    const message = makeMessage({ deliveryId: 'delivery-1' });
    const fetchStub = async () =>
      new Response(null, { status: 429, headers: { 'retry-after': '12' } });

    await processNotifyBatch(batchOf(message), store, { fetch: fetchStub });

    expect(message.ackCount).toBe(0);
    expect(message.retryCalls).toEqual([{ delaySeconds: 12 }]);
    // markFailed は呼ばれない -> attemptCount は変わらず、pending のまま
    expect(store.statusOf('delivery-1')).toBe('pending');
    expect(store.attemptCountOf('delivery-1')).toBe(0);
  });

  it('marks failed (not dead) and retries on a retryable (5xx) failure', async () => {
    const store = new FakeNotifyStore();
    store.seed(makeDelivery());
    const message = makeMessage({ deliveryId: 'delivery-1' });
    const fetchStub = async () => new Response('boom', { status: 503 });

    await processNotifyBatch(batchOf(message), store, { fetch: fetchStub });

    expect(message.ackCount).toBe(0);
    expect(message.retryCalls.length).toBe(1);
    // markFailed(dead:false) の結果、attemptCount がインクリメントされ pending に戻る
    expect(store.statusOf('delivery-1')).toBe('pending');
    expect(store.attemptCountOf('delivery-1')).toBe(1);
    expect(store.lastErrorOf('delivery-1')).not.toContain(WEBHOOK_URL);
  });

  it('marks the delivery dead and acks on a permanent (404) failure', async () => {
    const store = new FakeNotifyStore();
    store.seed(makeDelivery());
    const message = makeMessage({ deliveryId: 'delivery-1' });
    const fetchStub = async () => new Response('unknown webhook', { status: 404 });

    await processNotifyBatch(batchOf(message), store, { fetch: fetchStub });

    expect(message.ackCount).toBe(1);
    expect(message.retryCalls.length).toBe(0);
    expect(store.statusOf('delivery-1')).toBe('dead');
    expect(store.lastErrorOf('delivery-1')).not.toContain(WEBHOOK_URL);
  });

  it('marks the delivery dead and acks once attemptCount reaches the default max (5) without sending', async () => {
    const store = new FakeNotifyStore();
    store.seed(makeDelivery({ attemptCount: 5 }));
    const message = makeMessage({ deliveryId: 'delivery-1' });
    let fetchCalled = false;
    const fetchStub = async () => {
      fetchCalled = true;
      return new Response(null, { status: 204 });
    };

    await processNotifyBatch(batchOf(message), store, { fetch: fetchStub });

    expect(fetchCalled).toBe(false);
    expect(message.ackCount).toBe(1);
    expect(store.statusOf('delivery-1')).toBe('dead');
  });

  it('honors a custom maxAttempts option', async () => {
    const store = new FakeNotifyStore();
    store.seed(makeDelivery({ attemptCount: 2 }));
    const message = makeMessage({ deliveryId: 'delivery-1' });
    let fetchCalled = false;
    const fetchStub = async () => {
      fetchCalled = true;
      return new Response(null, { status: 204 });
    };

    await processNotifyBatch(batchOf(message), store, { fetch: fetchStub, maxAttempts: 2 });

    expect(fetchCalled).toBe(false);
    expect(store.statusOf('delivery-1')).toBe('dead');
  });

  it('processes messages independently so one failure does not block the rest of the batch', async () => {
    const store = new FakeNotifyStore();
    store.seed(makeDelivery({ deliveryId: 'ok-1', change: makeChange({ changeId: 'c-ok-1' }) }));
    store.seed(
      makeDelivery({ deliveryId: 'permanent-1', change: makeChange({ changeId: 'c-perm-1' }) }),
    );
    store.seed(makeDelivery({ deliveryId: 'ok-2', change: makeChange({ changeId: 'c-ok-2' }) }));

    const msgOk1 = makeMessage({ deliveryId: 'ok-1' });
    const msgPermanent = makeMessage({ deliveryId: 'permanent-1' });
    const msgOk2 = makeMessage({ deliveryId: 'ok-2' });

    // deliveryId は URL に含まれないため、webhookUrl を分岐材料にして 404 を再現する
    store.records.get('permanent-1')!.delivery = {
      ...store.records.get('permanent-1')!.delivery,
      webhookUrl: 'https://discord.com/api/webhooks/111111111111111111/permanentFailToken',
    };

    const dispatchingFetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('permanentFailToken')) {
        return new Response('gone', { status: 404 });
      }
      return new Response(null, { status: 204 });
    };

    await processNotifyBatch(batchOf(msgOk1, msgPermanent, msgOk2), store, {
      fetch: dispatchingFetch,
    });

    expect(store.statusOf('ok-1')).toBe('delivered');
    expect(store.statusOf('ok-2')).toBe('delivered');
    expect(store.statusOf('permanent-1')).toBe('dead');
    expect(msgOk1.ackCount).toBe(1);
    expect(msgOk2.ackCount).toBe(1);
    expect(msgPermanent.ackCount).toBe(1);
  });

  it('does not let an unexpected store error on one message block the rest of the batch', async () => {
    const store = new FakeNotifyStore();
    store.seed(makeDelivery({ deliveryId: 'ok-1' }));
    store.seed(makeDelivery({ deliveryId: 'throws-1' }));

    const originalGetPending = store.getPendingDelivery.bind(store);
    store.getPendingDelivery = async (deliveryId: string) => {
      if (deliveryId === 'throws-1') {
        throw new Error('simulated store outage');
      }
      return originalGetPending(deliveryId);
    };

    const msgOk = makeMessage({ deliveryId: 'ok-1' });
    const msgThrows = makeMessage({ deliveryId: 'throws-1' });
    const fetchStub = async () => new Response(null, { status: 204 });

    await processNotifyBatch(batchOf(msgOk, msgThrows), store, { fetch: fetchStub });

    expect(store.statusOf('ok-1')).toBe('delivered');
    expect(msgOk.ackCount).toBe(1);
    // 例外が起きたメッセージは失われないよう retry される
    expect(msgThrows.retryCalls.length).toBe(1);
    expect(msgThrows.ackCount).toBe(0);
  });
});
