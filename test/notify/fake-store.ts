/**
 * NotifyStore のインメモリフェイク実装 (テスト専用)。
 * D1 には依存しない。Lane E (src/notify/) は本物の D1 実装を知らない。
 */
import type { PendingDelivery, NotifyStore } from '../../src/shared/contracts';

export interface FakeDeliveryRecord {
  delivery: PendingDelivery;
  status: 'pending' | 'delivered' | 'failed' | 'dead';
  lastError: string | null;
}

export class FakeNotifyStore implements NotifyStore {
  readonly records = new Map<string, FakeDeliveryRecord>();

  seed(delivery: PendingDelivery): void {
    this.records.set(delivery.deliveryId, {
      delivery,
      status: 'pending',
      lastError: null,
    });
  }

  async getPendingDelivery(deliveryId: string): Promise<PendingDelivery | null> {
    const record = this.records.get(deliveryId);
    if (!record) return null;
    if (record.status !== 'pending') return null;
    return record.delivery;
  }

  async markDelivered(deliveryId: string): Promise<void> {
    const record = this.records.get(deliveryId);
    if (!record) return;
    record.status = 'delivered';
    record.lastError = null;
  }

  async markFailed(deliveryId: string, error: string, opts: { dead: boolean }): Promise<void> {
    const record = this.records.get(deliveryId);
    if (!record) return;
    record.status = opts.dead ? 'dead' : 'failed';
    record.lastError = error;
    if (!opts.dead) {
      // 失敗時は attemptCount をインクリメントし、次回 getPendingDelivery が
      // それを見えるようにする (実 D1 実装の attempt カウントアップを模す)。
      record.status = 'pending';
      record.delivery = {
        ...record.delivery,
        attemptCount: record.delivery.attemptCount + 1,
      };
    }
  }

  statusOf(deliveryId: string): FakeDeliveryRecord['status'] | undefined {
    return this.records.get(deliveryId)?.status;
  }

  attemptCountOf(deliveryId: string): number | undefined {
    return this.records.get(deliveryId)?.delivery.attemptCount;
  }

  lastErrorOf(deliveryId: string): string | null | undefined {
    return this.records.get(deliveryId)?.lastError;
  }
}

export function makeMessage<T>(body: T) {
  const acked = { count: 0 };
  const retried: Array<{ delaySeconds?: number } | undefined> = [];
  return {
    body,
    ack: () => {
      acked.count += 1;
    },
    retry: (opts?: { delaySeconds?: number }) => {
      retried.push(opts);
    },
    get ackCount() {
      return acked.count;
    },
    get retryCalls() {
      return retried;
    },
  };
}
