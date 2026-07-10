import { describe, expect, it } from 'vitest';
import { createSite, listAuditEventsBySubject } from '../../src/db';
import { authHeaders, buildTestApp, db, jsonHeaders, testEnv, uniqueName } from './helpers';

describe('PUT /api/sites/:id/robots-overrides (ADR-0009)', () => {
  it('rejects mode=ignore without a reason (400)', async () => {
    const { app } = buildTestApp();
    const site = await createSite(db(), { name: uniqueName('Robots Site') });

    const res = await app.request(
      `/api/sites/${site.id}/robots-overrides`,
      {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ canonical_origin: 'https://example.com', mode: 'ignore', confirm: true }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('reason_required');
  });

  it('rejects mode=ignore without confirm=true (400)', async () => {
    const { app } = buildTestApp();
    const site = await createSite(db(), { name: uniqueName('Robots Site') });

    const res = await app.request(
      `/api/sites/${site.id}/robots-overrides`,
      {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({
          canonical_origin: 'https://example.com',
          mode: 'ignore',
          reason: 'site owner monitoring their own property',
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('confirmation_required');
  });

  it('accepts a valid ignore override, persists it, and records an audit event', async () => {
    const { app } = buildTestApp();
    const site = await createSite(db(), { name: uniqueName('Robots Site') });
    const origin = 'https://example.com';

    const res = await app.request(
      `/api/sites/${site.id}/robots-overrides`,
      {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({
          canonical_origin: origin,
          mode: 'ignore',
          reason: 'site owner monitoring their own property',
          confirm: true,
        }),
      },
      testEnv()
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.mode).toBe('ignore');
    expect(body.warning).toBe(true);

    const events = await listAuditEventsBySubject(db(), `site:${site.id}:${origin}`);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('robots_override.enable');
    expect(events[0]?.reason).toBe('site owner monitoring their own property');

    const getRes = await app.request(`/api/sites/${site.id}/robots-overrides`, { headers: authHeaders() }, testEnv());
    const getBody = await getRes.json() as any;
    expect(getBody.has_active_override).toBe(true);
    expect(getBody.items).toHaveLength(1);
  });

  it('mode=enforce does not require reason/confirm', async () => {
    const { app } = buildTestApp();
    const site = await createSite(db(), { name: uniqueName('Robots Site') });

    const res = await app.request(
      `/api/sites/${site.id}/robots-overrides`,
      {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ canonical_origin: 'https://example.com', mode: 'enforce' }),
      },
      testEnv()
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.mode).toBe('enforce');
    expect(body.warning).toBe(false);
  });

  it('returns 404 for an unknown site', async () => {
    const { app } = buildTestApp();
    const res = await app.request(
      '/api/sites/nope/robots-overrides',
      {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ canonical_origin: 'https://example.com', mode: 'enforce' }),
      },
      testEnv()
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/sites/:id/robots-overrides (revert to enforce)', () => {
  it('reverts an ignore override to enforce and records an audit event', async () => {
    const { app } = buildTestApp();
    const site = await createSite(db(), { name: uniqueName('Robots Site') });
    const origin = 'https://example.com';

    await app.request(
      `/api/sites/${site.id}/robots-overrides`,
      {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ canonical_origin: origin, mode: 'ignore', reason: 'testing', confirm: true }),
      },
      testEnv()
    );

    const deleteRes = await app.request(
      `/api/sites/${site.id}/robots-overrides?canonical_origin=${encodeURIComponent(origin)}`,
      { method: 'DELETE', headers: authHeaders() },
      testEnv()
    );
    expect(deleteRes.status).toBe(200);
    const body = await deleteRes.json() as any;
    expect(body.mode).toBe('enforce');

    const events = await listAuditEventsBySubject(db(), `site:${site.id}:${origin}`);
    expect(events.some((e) => e.action === 'robots_override.enforce')).toBe(true);
  });

  it('requires canonical_origin query parameter (400)', async () => {
    const { app } = buildTestApp();
    const site = await createSite(db(), { name: uniqueName('Robots Site') });
    const res = await app.request(
      `/api/sites/${site.id}/robots-overrides`,
      { method: 'DELETE', headers: authHeaders() },
      testEnv()
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when no override exists for that origin', async () => {
    const { app } = buildTestApp();
    const site = await createSite(db(), { name: uniqueName('Robots Site') });
    const res = await app.request(
      `/api/sites/${site.id}/robots-overrides?canonical_origin=https://never-set.example.com`,
      { method: 'DELETE', headers: authHeaders() },
      testEnv()
    );
    expect(res.status).toBe(404);
  });
});
