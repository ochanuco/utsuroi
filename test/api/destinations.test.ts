import { describe, expect, it } from 'vitest';
import { authHeaders, buildTestApp, jsonHeaders, testEnv, uniqueName } from './helpers';

describe('POST/GET /api/destinations (webhook masking)', () => {
  it('never returns the plaintext webhook_url on create or read', async () => {
    const { app } = buildTestApp();
    const webhookUrl = 'https://discord.com/api/webhooks/1234567890/AbCdEfGhIjKlMnOpQrStUvWxYz';

    const createRes = await app.request(
      '/api/destinations',
      { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: uniqueName('Discord'), webhook_url: webhookUrl }) },
      testEnv()
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as any;
    expect(JSON.stringify(created)).not.toContain(webhookUrl);
    expect(created.webhook_url_masked).toBe('discord.com/***WxYz');
    expect(created.webhook_url).toBeUndefined();

    const getRes = await app.request(`/api/destinations/${created.id}`, { headers: authHeaders() }, testEnv());
    const fetched = await getRes.json() as any;
    expect(JSON.stringify(fetched)).not.toContain(webhookUrl);
    expect(fetched.webhook_url_masked).toBe('discord.com/***WxYz');
  });

  it('rejects a malformed webhook_url (400)', async () => {
    const { app } = buildTestApp();
    const res = await app.request(
      '/api/destinations',
      { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: 'Bad', webhook_url: 'not-a-url' }) },
      testEnv()
    );
    expect(res.status).toBe(400);
  });

  it('rejects a webhook_url blocked by the SSRF policy (400)', async () => {
    const { app } = buildTestApp();
    const res = await app.request(
      '/api/destinations',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: uniqueName('SSRF'), webhook_url: 'http://127.0.0.1/webhook' }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
  });

  it('rejects destination creation with 503 when WEBHOOK_ENC_KEY is not configured (no plaintext fallback)', async () => {
    const { app } = buildTestApp();
    const res = await app.request(
      '/api/destinations',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: uniqueName('No Key'), webhook_url: 'https://discord.com/api/webhooks/1/nokey' }),
      },
      testEnv({ WEBHOOK_ENC_KEY: undefined })
    );
    expect(res.status).toBe(503);
  });

  it('lists destinations with masked URLs', async () => {
    const { app } = buildTestApp();
    await app.request(
      '/api/destinations',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: uniqueName('List Discord'), webhook_url: 'https://discord.com/api/webhooks/1/secret1234' }),
      },
      testEnv()
    );
    const res = await app.request('/api/destinations', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    for (const item of body.items) {
      expect(item.webhook_url).toBeUndefined();
      expect(item.webhook_url_masked).toEqual(expect.any(String));
    }
  });

  it('deletes a destination', async () => {
    const { app } = buildTestApp();
    const created = await (
      await app.request(
        '/api/destinations',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ name: uniqueName('Delete Me'), webhook_url: 'https://discord.com/api/webhooks/2/secret5678' }),
        },
        testEnv()
      )
    ).json() as any;

    const deleteRes = await app.request(
      `/api/destinations/${created.id}`,
      { method: 'DELETE', headers: authHeaders() },
      testEnv()
    );
    expect(deleteRes.status).toBe(200);

    const getRes = await app.request(`/api/destinations/${created.id}`, { headers: authHeaders() }, testEnv());
    expect(getRes.status).toBe(404);
  });

  it('returns 404 when deleting an unknown destination', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/destinations/nope', { method: 'DELETE', headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
  });
});
