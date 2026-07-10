import type { Env } from './shared/env';
import type { NotifyQueueMessage } from './shared/contracts';
import { createApp } from './api';
import { createD1NotifyStore } from './db';
import { processNotifyBatch } from './notify';
import type { NotifyBatchMessage, NotifyMessageBatch } from './notify';
import { runReconciliation } from './pipeline/reconcile';

export { MonitorObject, monitorControlFactory } from './do/monitorObject';
export { HostObject, hostLimiterFactory } from './do/hostObject';

/** Cloudflare Queues の MessageBatch を notify バッチ層の最小 interface へ変換する薄いアダプタ */
function toNotifyMessageBatch(batch: MessageBatch<NotifyQueueMessage>): NotifyMessageBatch {
  return {
    messages: batch.messages.map(
      (msg): NotifyBatchMessage => ({
        body: msg.body,
        ack: () => msg.ack(),
        retry: (retryOpts) => msg.retry(retryOpts),
      }),
    ),
  };
}

const app = createApp();
app.get('/', (c) => c.text('utsuroi: ok'));

const handler = {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runReconciliation(env);
  },
  async queue(batch: MessageBatch<NotifyQueueMessage>, env: Env): Promise<void> {
    await processNotifyBatch(toNotifyMessageBatch(batch), createD1NotifyStore(env.DB, env.WEBHOOK_ENC_KEY));
  },
} satisfies ExportedHandler<Env, NotifyQueueMessage>;

export default handler;
