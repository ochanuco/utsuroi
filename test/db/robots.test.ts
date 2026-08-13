import { describe, expect, it } from 'vitest';
import {
  countConsecutiveUnavailableRobotsEvaluations,
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

  it('normalizes canonical_origin so a trailing slash from the UI still matches URL.origin (ADR-0017)', async () => {
    const d = db();
    const site = await createSite(d, { name: 'Trailing Slash Site' });

    // UI は sites.primary_origin を初期値にするため 'https://example.com/' が入りうる
    const created = await upsertRobotsPolicy(d, {
      siteId: site.id,
      canonicalOrigin: 'https://slash.example.com/',
      mode: 'ignore',
      reason: 'trailing slash from the override form',
    });
    expect(created.canonicalOrigin).toBe('https://slash.example.com');

    // pipeline 側は new URL(source.url).origin で引く
    expect(await getRobotsMode(d, site.id, 'https://slash.example.com')).toBe('ignore');
    // 末尾スラッシュ付きで引いても同じ行に当たる
    expect(await getRobotsMode(d, site.id, 'https://slash.example.com/')).toBe('ignore');

    // 表記ゆれで行が増えないこと
    const reupserted = await upsertRobotsPolicy(d, {
      siteId: site.id,
      canonicalOrigin: 'https://slash.example.com',
      mode: 'enforce',
      reason: null,
    });
    expect(reupserted.id).toBe(created.id);
    const { results } = await d
      .prepare(`SELECT COUNT(*) as n FROM robots_policies WHERE site_id = ?`)
      .bind(site.id)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(1);
  });

  it('counts only the unbroken run of unavailable evaluations from the newest (ADR-0017)', async () => {
    const d = db();
    const origin = 'https://consecutive.example.com';
    const mk = async (checkedAt: string, unavailable: boolean): Promise<void> => {
      await createRobotsEvaluation(d, {
        origin,
        verdict: unavailable ? 'disallowed' : 'allowed',
        robotsUrl: `${origin}/robots.txt`,
        checkedAt,
        userAgentGroup: unavailable ? 'unavailable' : '*',
        unavailable,
        robotsWouldBlock: unavailable,
      });
    };

    await mk('2026-08-07T12:00:00.000Z', true);
    await mk('2026-08-07T13:00:00.000Z', false); // 途中で復旧している
    await mk('2026-08-07T14:00:00.000Z', true);
    await mk('2026-08-07T15:00:00.000Z', true);

    // 直近2件だけが連続 unavailable。それ以前は allowed で途切れる
    expect(await countConsecutiveUnavailableRobotsEvaluations(d, origin, 3)).toBe(2);

    await mk('2026-08-07T16:00:00.000Z', true);
    expect(await countConsecutiveUnavailableRobotsEvaluations(d, origin, 3)).toBe(3);

    // 最新が allowed なら 0
    await mk('2026-08-07T17:00:00.000Z', false);
    expect(await countConsecutiveUnavailableRobotsEvaluations(d, origin, 3)).toBe(0);
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
