import { describe, expect, it } from 'vitest';
import {
  createRobotsEvaluation,
  createSite,
  getLatestRobotsEvaluation,
  getRobotsMode,
  getRobotsPolicy,
  upsertRobotsPolicy,
} from '../../src/db';
import { db } from './helpers';

describe('robots_policies (ADR-0009 site_id + canonical_origin override)', () => {
  it('defaults to enforce when no explicit override row exists', async () => {
    const d = db();
    const site = await createSite(d, { name: 'No Override Site' });
    expect(await getRobotsPolicy(d, site.id, 'https://example.com')).toBeNull();
    expect(await getRobotsMode(d, site.id, 'https://example.com')).toBe('enforce');
  });

  it('upserts an ignore override with a reason, then updates it in place (UNIQUE(site_id, canonical_origin))', async () => {
    const d = db();
    const site = await createSite(d, { name: 'Override Site' });
    const origin = 'https://override.example.com';

    const created = await upsertRobotsPolicy(d, {
      siteId: site.id,
      canonicalOrigin: origin,
      mode: 'ignore',
      reason: 'site owner monitoring their own property',
      updatedBy: 'admin@example.com',
    });
    expect(created.mode).toBe('ignore');
    expect(await getRobotsMode(d, site.id, origin)).toBe('ignore');

    const updated = await upsertRobotsPolicy(d, {
      siteId: site.id,
      canonicalOrigin: origin,
      mode: 'enforce',
      reason: null,
      updatedBy: 'admin@example.com',
    });
    // same policy id (upsert in place, not a new row)
    expect(updated.id).toBe(created.id);
    expect(await getRobotsMode(d, site.id, origin)).toBe('enforce');

    const { results } = await d
      .prepare(`SELECT COUNT(*) as n FROM robots_policies WHERE site_id = ? AND canonical_origin = ?`)
      .bind(site.id, origin)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(1);
  });

  it('records robots_evaluations with robots_would_block for override(ignore) bookkeeping (ADR-0009)', async () => {
    const d = db();
    const origin = 'https://evaluated.example.com';
    await createRobotsEvaluation(d, {
      origin,
      verdict: 'allowed', // ignore override lets fetch continue
      robotsUrl: `${origin}/robots.txt`,
      userAgentGroup: 'utsuroibot',
      matchedRule: 'disallow: /private',
      robotsWouldBlock: true,
    });

    const latest = await getLatestRobotsEvaluation(d, origin);
    expect(latest?.verdict).toBe('allowed');
    expect(latest?.robotsWouldBlock).toBe(true);
    expect(latest?.matchedRule).toBe('disallow: /private');
  });
});
