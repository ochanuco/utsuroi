/**
 * fetcher_policies / fetcher_policy_entries ⇔ shared FetcherPolicy 型の相互変換 (SPEC §8)。
 *
 * AllowList は entries テーブルへのメンバーシップ、OrderList は order_index で表現する。
 * これにより「AllowList の全 Fetcher が OrderList に 1 回だけ含まれる」という不変条件が
 * データ構造上自動的に満たされる。
 */
import type { FailureClass } from '../shared/types';
import type { FetcherPolicy, FetcherPolicyEntry } from '../shared/contracts';
import { newId, nowIso, parseJson, toJson } from './util';

interface PolicyEntryRow {
  fetcher_id: string;
  order_index: number;
  proceed_on: string | null;
}

/**
 * Site の Fetcher Policy を作成/更新する (全置換)。
 * SPEC §8 の不変条件 (AllowList 非空、AllowList⇔OrderList の集合一致) を事前検証する。
 */
export async function putFetcherPolicy(
  db: D1Database,
  siteId: string,
  policy: FetcherPolicy
): Promise<void> {
  validateFetcherPolicy(policy);

  const now = nowIso();
  const existing = await db
    .prepare(`SELECT id FROM fetcher_policies WHERE site_id = ?`)
    .bind(siteId)
    .first<{ id: string }>();

  const policyId = existing?.id ?? newId();

  const statements: D1PreparedStatement[] = [];

  if (existing) {
    statements.push(db.prepare(`UPDATE fetcher_policies SET updated_at = ? WHERE id = ?`).bind(now, policyId));
    statements.push(
      db.prepare(`DELETE FROM fetcher_policy_entries WHERE fetcher_policy_id = ?`).bind(policyId)
    );
  } else {
    statements.push(
      db
        .prepare(
          `INSERT INTO fetcher_policies (id, site_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
        )
        .bind(policyId, siteId, now, now)
    );
  }

  policy.orderList.forEach((entry, index) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO fetcher_policy_entries (id, fetcher_policy_id, fetcher_id, order_index, proceed_on)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(newId(), policyId, entry.fetcherId, index, toJson(entry.proceedOn ?? null))
    );
  });

  await db.batch(statements);
}

export async function getFetcherPolicy(db: D1Database, siteId: string): Promise<FetcherPolicy | null> {
  const policyRow = await db
    .prepare(`SELECT id FROM fetcher_policies WHERE site_id = ?`)
    .bind(siteId)
    .first<{ id: string }>();
  if (!policyRow) return null;

  const { results } = await db
    .prepare(
      `SELECT fetcher_id, order_index, proceed_on FROM fetcher_policy_entries
       WHERE fetcher_policy_id = ? ORDER BY order_index ASC`
    )
    .bind(policyRow.id)
    .all<PolicyEntryRow>();

  const orderList: FetcherPolicyEntry[] = results.map((row) => ({
    fetcherId: row.fetcher_id,
    proceedOn: parseJson<FailureClass[] | null>(row.proceed_on, null) ?? undefined,
  }));

  return {
    allowList: orderList.map((entry) => entry.fetcherId),
    orderList,
  };
}

function validateFetcherPolicy(policy: FetcherPolicy): void {
  if (policy.allowList.length === 0) {
    throw new Error('fetcher policy allowList must not be empty');
  }
  const allowSet = new Set(policy.allowList);
  if (allowSet.size !== policy.allowList.length) {
    throw new Error('fetcher policy allowList must not contain duplicates');
  }
  const orderIds = policy.orderList.map((entry) => entry.fetcherId);
  const orderSet = new Set(orderIds);
  if (orderSet.size !== orderIds.length) {
    throw new Error('fetcher policy orderList must not reference a fetcher more than once');
  }
  if (orderSet.size !== allowSet.size || [...orderSet].some((id) => !allowSet.has(id))) {
    throw new Error('fetcher policy orderList must exactly match allowList membership');
  }
}
