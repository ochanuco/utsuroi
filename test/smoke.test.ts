import { env, SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('worker responds', async () => {
  const res = await SELF.fetch('https://example.com/');
  expect(res.status).toBe(200);
});

it('bindings are provided', () => {
  expect(env.DB).toBeDefined();
  expect(env.BODIES).toBeDefined();
  expect(env.NOTIFY_QUEUE).toBeDefined();
});
