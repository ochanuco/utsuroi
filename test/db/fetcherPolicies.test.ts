import { describe, expect, it } from 'vitest';
import { createExecutor, createFetcher, createSite, getFetcherPolicy, putFetcherPolicy } from '../../src/db';
import { db } from './helpers';

let fetcherSeq = 0;

async function makeFetchers(d: D1Database) {
  const suffix = `${Date.now()}-${fetcherSeq++}`;
  const executor = await createExecutor(d, { kind: 'cloudflare', name: 'CF' });
  const httpId = `cf-http-apac-${suffix}`;
  const browserId = `home-browser-${suffix}`;
  await createFetcher(d, { id: httpId, executorId: executor.id, fetchMode: 'http' });
  await createFetcher(d, { id: browserId, executorId: executor.id, fetchMode: 'browser' });
  return { httpId, browserId };
}

describe('fetcher_policies / fetcher_policy_entries (SPEC §8)', () => {
  it('round-trips allowList/orderList through putFetcherPolicy/getFetcherPolicy', async () => {
    const d = db();
    const site = await createSite(d, { name: 'Policy Site' });
    const { httpId, browserId } = await makeFetchers(d);

    await putFetcherPolicy(d, site.id, {
      allowList: [httpId, browserId],
      orderList: [{ fetcherId: httpId }, { fetcherId: browserId, proceedOn: ['timeout', 'http_5xx'] }],
    });

    const policy = await getFetcherPolicy(d, site.id);
    expect(policy).not.toBeNull();
    expect(policy?.allowList).toEqual([httpId, browserId]);
    expect(policy?.orderList).toEqual([
      { fetcherId: httpId, proceedOn: undefined },
      { fetcherId: browserId, proceedOn: ['timeout', 'http_5xx'] },
    ]);
  });

  it('replaces the previous entries entirely on a second put (full replace semantics)', async () => {
    const d = db();
    const site = await createSite(d, { name: 'Policy Site 2' });
    const { httpId, browserId } = await makeFetchers(d);

    await putFetcherPolicy(d, site.id, {
      allowList: [httpId, browserId],
      orderList: [{ fetcherId: httpId }, { fetcherId: browserId }],
    });
    await putFetcherPolicy(d, site.id, {
      allowList: [browserId],
      orderList: [{ fetcherId: browserId }],
    });

    const policy = await getFetcherPolicy(d, site.id);
    expect(policy?.allowList).toEqual([browserId]);
  });

  it('rejects an orderList that does not exactly match allowList membership', async () => {
    const d = db();
    const site = await createSite(d, { name: 'Invalid Policy Site' });
    const { httpId, browserId } = await makeFetchers(d);

    await expect(
      putFetcherPolicy(d, site.id, {
        allowList: [httpId],
        orderList: [{ fetcherId: httpId }, { fetcherId: browserId }],
      })
    ).rejects.toThrow();
  });

  it('rejects an empty allowList', async () => {
    const d = db();
    const site = await createSite(d, { name: 'Empty Policy Site' });
    await expect(putFetcherPolicy(d, site.id, { allowList: [], orderList: [] })).rejects.toThrow();
  });

  it('returns null when no policy has been set for the site', async () => {
    const d = db();
    const site = await createSite(d, { name: 'No Policy Site' });
    expect(await getFetcherPolicy(d, site.id)).toBeNull();
  });
});
