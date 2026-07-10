import { describe, expect, it } from 'vitest';
import { listAuditEventsBySubject, recordAuditEvent } from '../../src/db';
import { db } from './helpers';

describe('audit_events (append-only, ADR-0009)', () => {
  it('records events with actor/action/subject/reason/payload and preserves ordering', async () => {
    const d = db();
    const subject = 'robots_override:site-1:https://example.com';

    await recordAuditEvent(d, {
      actor: 'admin@example.com',
      action: 'robots_override.enable',
      subject,
      reason: 'site owner monitoring their own property',
      payload: { robotsHash: 'sha256:abc', matchedRule: 'disallow: /private' },
    });
    await recordAuditEvent(d, {
      actor: 'admin@example.com',
      action: 'robots_override.disable',
      subject,
      reason: 'no longer needed',
    });

    const events = await listAuditEventsBySubject(d, subject);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      actor: 'admin@example.com',
      action: 'robots_override.enable',
      subject,
      reason: 'site owner monitoring their own property',
    });
    expect(events[0]?.payload).toEqual({ robotsHash: 'sha256:abc', matchedRule: 'disallow: /private' });
    expect(events[1]).toMatchObject({
      actor: 'admin@example.com',
      action: 'robots_override.disable',
      subject,
      reason: 'no longer needed',
    });
    expect(events[1]?.payload).toBeNull();
  });

  it('applies a default LIMIT to listAuditEventsBySubject so a subject cannot return unbounded rows', async () => {
    const d = db();
    const subject = 'robots_override:site-2:https://example.org';
    const defaultLimit = 200;

    for (let i = 0; i < defaultLimit + 1; i++) {
      await recordAuditEvent(d, {
        actor: 'admin@example.com',
        action: 'robots_override.enable',
        subject,
        reason: `reason-${i}`,
      });
    }

    const events = await listAuditEventsBySubject(d, subject);
    expect(events).toHaveLength(defaultLimit);
  });
});
