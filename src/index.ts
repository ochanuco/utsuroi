import { DurableObject } from 'cloudflare:workers';
import type { Env } from './shared/env';
import type { NotifyQueueMessage } from './shared/contracts';

// Wave2 で実装が入る。スタブは wrangler / vitest-pool-workers の起動用。
export class MonitorObject extends DurableObject<Env> {}
export class HostObject extends DurableObject<Env> {}

const handler = {
  async fetch(_req: Request, _env: Env): Promise<Response> {
    return new Response('utsuroi: ok');
  },
  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {},
  async queue(batch: MessageBatch<NotifyQueueMessage>, _env: Env): Promise<void> {
    for (const msg of batch.messages) msg.ack();
  },
} satisfies ExportedHandler<Env, NotifyQueueMessage>;

export default handler;
