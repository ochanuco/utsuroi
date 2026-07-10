import { describe, expect, it } from 'vitest';
import {
  createExecutor,
  createFetcher,
  createRobotsEvaluation,
  createSite,
  createSubscription,
  deleteSiteCascade,
  getDestination,
  getFetcherPolicy,
  getSite,
  putFetcherPolicy,
  upsertRobotsPolicy,
} from '../../src/db';
import { buildFixture, db } from './helpers';

async function countRows(d: D1Database, table: string, column: string, id: string): Promise<number> {
  const row = await d
    .prepare(`SELECT COUNT(*) as count FROM ${table} WHERE ${column} = ?`)
    .bind(id)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

describe('deleteSiteCascade (Site削除機能: fetcher_policy / robots_policies / subscriptions)', () => {
  it('removes fetcher_policy_entries/fetcher_policies/robots_policies/subscriptions and the site itself, but keeps the shared robots_evaluations cache', async () => {
    const d = db();
    const site = await createSite(d, { name: 'Cascade Site' });

    const executor = await createExecutor(d, { kind: 'cloudflare', name: 'CF' });
    const fetcherId = crypto.randomUUID();
    await createFetcher(d, { id: fetcherId, executorId: executor.id, fetchMode: 'http' });
    await putFetcherPolicy(d, site.id, { allowList: [fetcherId], orderList: [{ fetcherId }] });

    await upsertRobotsPolicy(d, {
      siteId: site.id,
      canonicalOrigin: 'https://cascade.example',
      mode: 'ignore',
      reason: 'test',
      updatedBy: 'admin',
    });

    // robots_evaluations は origin単位の共有キャッシュ (site_idを持たない) なので、
    // 削除対象から除外されることを確認する。
    const evaluation = await createRobotsEvaluation(d, {
      origin: 'https://cascade.example',
      verdict: 'allowed',
      robotsUrl: 'https://cascade.example/robots.txt',
      userAgentGroup: 'utsuroibot',
    });

    // destinations/subscriptions は別レーン (buildFixture) の destination を再利用する
    const { destination } = await buildFixture(d, { siteName: 'Fixture Site For Destination' });
    const subscription = await createSubscription(d, { destinationId: destination.id, siteId: site.id });

    const deleted = await deleteSiteCascade(d, site.id);
    expect(deleted).toBe(true);

    expect(await getSite(d, site.id)).toBeNull();
    expect(await getFetcherPolicy(d, site.id)).toBeNull();
    expect(await countRows(d, 'fetcher_policy_entries', 'fetcher_id', fetcherId)).toBe(0);
    expect(await countRows(d, 'robots_policies', 'site_id', site.id)).toBe(0);
    expect(await countRows(d, 'subscriptions', 'id', subscription.id)).toBe(0);

    // 共有キャッシュ (robots_evaluations) は残る
    const stillCached = await d.prepare(`SELECT id FROM robots_evaluations WHERE id = ?`).bind(evaluation.id).first();
    expect(stillCached).not.toBeNull();

    // destination自体はsite削除で消えない (別レーンのリソース)
    expect(await getDestination(d, destination.id)).not.toBeNull();
  });

  it('returns false and changes nothing for an unknown site id', async () => {
    const d = db();
    expect(await deleteSiteCascade(d, 'does-not-exist')).toBe(false);
  });

  it('is safe to call on a site with no fetcher policy / robots policy / subscriptions configured', async () => {
    const d = db();
    // NOTE: deleteSiteCascade 自体は Source の有無を見ない (409ガードはAPI層の責務、
    // test/api/sites.test.ts で検証する)。ここでは Source が無い「素の」Siteに対する
    // 単体呼び出しが例外なく完了することだけを見る。
    const site = await createSite(d, { name: 'Bare Site' });
    const deleted = await deleteSiteCascade(d, site.id);
    expect(deleted).toBe(true);
    expect(await getSite(d, site.id)).toBeNull();
  });
});
