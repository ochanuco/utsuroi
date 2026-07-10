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
});
