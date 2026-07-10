/**
 * page Source の内容処理 (SPEC §12, §13): 正規化 → R2保存 → 前回Snapshotとの比較 → 差分 → Change。
 */
import { normalizeHtml, diffText, compareSnapshots } from '../normalize';
import type { FetchSuccess, NormalizedContent } from '../shared/contracts';
import {
  createSnapshot,
  createDeliveryIfNew,
  insertChangeIfNew,
  listMatchingSubscriptions,
  type SnapshotRow,
  type TargetRow,
} from '../db';
import { bodyKey, normalizedKey, diffKey, putIfAbsent, truncateDiffPreview } from './r2';
import type { CheckContext } from './types';

interface SourceConfig {
  ignoreSelectors?: string[];
  includeSelectors?: string[];
  stripQueryParams?: string[];
}

/** sources.config (migrations/0002_wave2.sql の追加列) から正規化オプションを読む */
export async function loadSourceConfig(db: D1Database, sourceId: string): Promise<SourceConfig> {
  const row = await db
    .prepare(`SELECT config FROM sources WHERE id = ?`)
    .bind(sourceId)
    .first<{ config: string | null }>();
  if (!row?.config) return {};
  try {
    return JSON.parse(row.config) as SourceConfig;
  } catch {
    return {};
  }
}

export async function processPageContent(
  ctx: CheckContext,
  target: TargetRow,
  previousSnapshot: SnapshotRow | null,
  checkAttemptId: string | null,
  outcome: FetchSuccess,
  body: Uint8Array,
): Promise<void> {
  const config = await loadSourceConfig(ctx.db, ctx.source.id);
  const normalized = await normalizeHtml(body, {
    baseUrl: target.url,
    ignoreSelectors: config.ignoreSelectors,
    includeSelectors: config.includeSelectors,
    stripQueryParams: config.stripQueryParams,
  });

  await putIfAbsent(ctx.env.BODIES, bodyKey(normalized.rawHash), body);
  await putIfAbsent(ctx.env.BODIES, normalizedKey(normalized.textHash), normalized.extractedText);

  const snapshotId = crypto.randomUUID();
  const fetchedAtIso = new Date(ctx.now()).toISOString();
  await createSnapshot(ctx.db, {
    id: snapshotId,
    monitorId: ctx.monitor.id,
    targetId: target.id,
    checkAttemptId,
    fetchedAt: fetchedAtIso,
    httpStatus: outcome.status,
    contentType: outcome.contentType,
    etag: outcome.etag,
    lastModified: outcome.lastModified,
    bodyHash: normalized.rawHash,
    r2Key: bodyKey(normalized.rawHash),
    normalizedHash: normalized.normalizedHash,
    normalizedR2Key: normalizedKey(normalized.textHash),
    textHash: normalized.textHash,
    normalizationVersion: normalized.normalizationVersion,
  });

  // 初回 Snapshot は比較対象が無いため Change を作らない (SPEC §12/§13)
  if (!previousSnapshot) return;

  const previousContent: NormalizedContent = {
    normalizedHtml: '',
    extractedText: '',
    normalizationVersion: previousSnapshot.normalizationVersion ?? normalized.normalizationVersion,
    rawHash: previousSnapshot.bodyHash ?? '',
    normalizedHash: previousSnapshot.normalizedHash ?? '',
    textHash: previousSnapshot.textHash ?? '',
  };
  const cmp = compareSnapshots(previousContent, normalized);
  if (!cmp.changed) return;

  let previousText = '';
  if (previousSnapshot.normalizedR2Key) {
    const obj = await ctx.env.BODIES.get(previousSnapshot.normalizedR2Key);
    previousText = obj ? await obj.text() : '';
  }
  const diff = diffText(previousText, normalized.extractedText);

  const changeId = crypto.randomUUID();
  const dedupeKey = cmp.level === 'text_hash' ? normalized.textHash : normalized.normalizedHash;

  let diffR2Key: string | null = null;
  if (diff.unifiedDiff) {
    diffR2Key = diffKey(changeId);
    await ctx.env.BODIES.put(diffR2Key, diff.unifiedDiff);
  }

  const inserted = await insertChangeIfNew(ctx.db, {
    id: changeId,
    monitorId: ctx.monitor.id,
    targetId: target.id,
    targetUrl: target.url,
    kind: 'updated',
    diffLevel: cmp.level,
    dedupeKey,
    previousSnapshotId: previousSnapshot.id,
    snapshotId,
    diffR2Key,
    diffPreview: diff.unifiedDiff ? truncateDiffPreview(diff.unifiedDiff) : null,
    detectedAt: fetchedAtIso,
  });

  // inserted.inserted が false (dedupeKey 重複) でも、前回実行が Change 挿入後・delivery/enqueue 前に
  // クラッシュした可能性があるため、配送は常に inserted.row に対して行う (at-least-once 復旧)。
  // createDeliveryIfNew 自身が冪等 (insert-if-new) なので毎回呼んでも安全。changeIds だけは
  // 「今回新規検出した change」を表すため inserted.inserted の場合のみ積む。
  const subs = await listMatchingSubscriptions(ctx.db, {
    siteId: ctx.site.id,
    monitorId: ctx.monitor.id,
    kind: 'updated',
  });
  for (const sub of subs) {
    const delivery = await createDeliveryIfNew(ctx.db, inserted.row.id, sub.destinationId);
    if (delivery.inserted) {
      await ctx.env.NOTIFY_QUEUE.send({ deliveryId: delivery.row.id });
    }
  }
  if (inserted.inserted) {
    ctx.changeIds.push(inserted.row.id);
  }
}
