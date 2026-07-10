import { describe, expect, it } from 'vitest';
import { recordAuditEvent } from '../../src/db';
import { authHeaders, buildTestApp, db, testEnv, uniqueName } from './helpers';

describe('GET /api/audit-events', () => {
  it('returns recent audit events', async () => {
    const { app } = buildTestApp();
    const subject = uniqueName('audit-subject');
    await recordAuditEvent(db(), { actor: 'admin', action: 'robots_override.enable', subject, reason: 'r1' });
    await recordAuditEvent(db(), { actor: 'admin', action: 'robots_override.enforce', subject, reason: null });

    const res = await app.request('/api/audit-events', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.some((e: { subject: string }) => e.subject === subject)).toBe(true);
  });

  it('requires auth', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/audit-events', {}, testEnv());
    expect(res.status).toBe(401);
  });

  it('reports the true total count, not just the fetched page size', async () => {
    const { app } = buildTestApp();
    const subject = uniqueName('audit-subject-paged');
    const pageLimit = 5;
    const totalEvents = pageLimit + 3;
    for (let i = 0; i < totalEvents; i++) {
      await recordAuditEvent(db(), { actor: 'admin', action: 'robots_override.enable', subject, reason: null });
    }

    const res = await app.request(`/api/audit-events?limit=${pageLimit}&offset=0`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.items).toHaveLength(pageLimit);
    expect(body.total).toBeGreaterThanOrEqual(totalEvents);
    expect(body.total).not.toBe(body.items.length);
  });
});
