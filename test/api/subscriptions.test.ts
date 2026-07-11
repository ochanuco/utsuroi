import { describe, expect, it } from 'vitest';
import { createDestination, createSite } from '../../src/db';
import { authHeaders, buildTestApp, db, jsonHeaders, testEnv, uniqueName } from './helpers';

async function makeDestination() {
  return createDestination(db(), {
    name: uniqueName('Sub Destination'),
    webhookUrl: 'https://discord.com/api/webhooks/9/abcd1234',
  });
}

describe('POST/GET/DELETE /api/subscriptions', () => {
  it('creates a subscription scoped to a site and kind', async () => {
    const { app } = buildTestApp();
    const destination = await makeDestination();
    const site = await createSite(db(), { name: uniqueName('Sub Site') });

    const res = await app.request(
      '/api/subscriptions',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ destination_id: destination.id, site_id: site.id, kind: 'updated' }),
      },
      testEnv()
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.destination_id).toBe(destination.id);
    expect(body.site_id).toBe(site.id);
    expect(body.kind).toBe('updated');
  });

  it('returns 404 for an unknown destination_id', async () => {
    const { app } = buildTestApp();
    const res = await app.request(
      '/api/subscriptions',
      { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ destination_id: 'nope' }) },
      testEnv()
    );
    expect(res.status).toBe(404);
  });

  it('lists subscriptions filtered by destination_id, and deletes one', async () => {
    const { app } = buildTestApp();
    const destination = await makeDestination();
    const created = await (
      await app.request(
        '/api/subscriptions',
        { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ destination_id: destination.id }) },
        testEnv()
      )
    ).json() as any;

    const listRes = await app.request(
      `/api/subscriptions?destination_id=${destination.id}`,
      { headers: authHeaders() },
      testEnv()
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as any;
    expect(listBody.items.some((s: { id: string }) => s.id === created.id)).toBe(true);

    const deleteRes = await app.request(
      `/api/subscriptions/${created.id}`,
      { method: 'DELETE', headers: authHeaders() },
      testEnv()
    );
    expect(deleteRes.status).toBe(200);

    const afterRes = await app.request(
      `/api/subscriptions?destination_id=${destination.id}`,
      { headers: authHeaders() },
      testEnv()
    );
    const afterBody = await afterRes.json() as any;
    expect(afterBody.items.some((s: { id: string }) => s.id === created.id)).toBe(false);
  });

  it('requires destination_id query parameter to list (400)', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/subscriptions', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(400);
  });

  it('returns 404 when deleting an unknown subscription', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/subscriptions/nope', { method: 'DELETE', headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
  });

  it('rejects creating a subscription against an archived destination (400 destination_archived, ADR-0012)', async () => {
    const { app } = buildTestApp();
    const destination = await makeDestination();

    const archiveRes = await app.request(
      `/api/destinations/${destination.id}/archive`,
      { method: 'POST', headers: authHeaders() },
      testEnv()
    );
    expect(archiveRes.status).toBe(200);

    const res = await app.request(
      '/api/subscriptions',
      { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ destination_id: destination.id }) },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('destination_archived');
  });
});
