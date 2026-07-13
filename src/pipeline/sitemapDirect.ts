/**
 * Sitemap Direct モード (ADR-0010 Phase A, docs/adr/0010-detection-chain-and-source-promotion.md)。
 *
 * sitemap / sitemap-index Source の既定挙動: 指定した「1つの」sitemap (urlset でも
 * sitemap-index でもよい) に直接列挙されている URL 集合 (loc + 任意で lastmod) を
 * 1つの決定論的ドキュメントに正規化し、page監視と同じ snapshot+diff (ADR-0006) で
 * 前回との差分を検知する。
 *
 * 子を辿らない・実URLの本文を取得しない・個々のURLをTarget化しない。
 * (旧: processFeedContent の sitemap-index 子展開が実障害で 6,021 件の Target を
 * 作りジョブを止めた。本モードは URL 集合ぜんたいで snapshot 1件・diff 1回に
 * 抑えることでこの問題を解消する — ADR-0010 「Positive」節参照)
 */
import { parseSource } from '../adapters';
import { AdapterParseError } from '../adapters/errors';
import { diffText, extractCharsetFromContentType } from '../normalize';
import type { FeedItem, FetchSuccess } from '../shared/contracts';
import { sha256Hex } from '../shared/hash';
import {
  createSnapshot,
  insertChangeIfNew,
  type SnapshotRow,
  type TargetRow,
} from '../db';
import { bodyKey, normalizedKey, diffKey, putIfAbsent, truncateDiffPreview } from './r2';
import { notifyDetectedChanges } from './notify';
import type { CheckContext } from './types';

/** Sitemap Direct ドキュメントの正規化フォーマット版。フォーマット変更時にインクリメント */
export const SITEMAP_DOCUMENT_VERSION = 1;

/**
 * items (loc + lastmod) を loc昇順・重複排除した決定論的テキストに正規化する。
 * これが Sitemap Direct の唯一の差分対象ドキュメント。各行は `${loc}\t${lastmod ?? '-'}\n`
 * (末尾にも改行を入れる)。行末尾を全行そろえるのは、diffLines (行単位diff) が「末尾に
 * 改行のない最終行」を特別扱いするため — 末尾改行なしのまま末尾に1行追記すると、
 * 追記前の最終行が「改行の有無が変わった」ことで無関係に removed/added 扱いされてしまい、
 * 末尾への追加が実質的な増減 (+1/-0) ではなく (+1/-1) に見えてしまう。
 * 同一 loc が複数回現れる場合はアダプタと同じ「最初の出現を採用」規約に合わせる。
 */
export function buildSitemapDocument(items: FeedItem[]): string {
  const byLoc = new Map<string, string | null>();
  for (const item of items) {
    if (!item.url) continue;
    if (!byLoc.has(item.url)) byLoc.set(item.url, item.updatedAt);
  }
  const locs = Array.from(byLoc.keys()).sort();
  return locs.map((loc) => `${loc}\t${byLoc.get(loc) ?? '-'}\n`).join('');
}

async function readDocumentFromR2(env: CheckContext['env'], key: string | null): Promise<string> {
  if (!key) return '';
  const obj = await env.BODIES.get(key);
  return obj ? await obj.text() : '';
}

/**
 * sitemap / sitemap-index Source の Source URL 本体取得後の処理 (Sitemap Direct)。
 * pageContent.ts の processPageContent と対称なフロー (parse → normalize → R2 →
 * snapshot → 前回比較 → diff → Change → 配信)。Target は呼び出し側 (runCheck.ts) が
 * 解決した Source URL 自体の単一 Target のみを使い、ここでは追加の Target を作らない。
 */
export async function processSitemapDirect(
  ctx: CheckContext,
  target: TargetRow,
  previousSnapshot: SnapshotRow | null,
  checkAttemptId: string | null,
  outcome: FetchSuccess,
  body: Uint8Array,
): Promise<void> {
  // feed.ts の作法に合わせる: パース不能な本文はフェッチ自体は成功として扱いつつ
  // (attempt は既に success で記録済み) Snapshot を作らずスキップする。
  let parsed;
  try {
    parsed = parseSource(ctx.source.type, body, {
      baseUrl: ctx.source.url,
      headerCharset: extractCharsetFromContentType(outcome.contentType),
    });
  } catch (err) {
    if (err instanceof AdapterParseError) return;
    throw err;
  }

  const document = buildSitemapDocument(parsed.items);
  const [rawHash, docHash] = await Promise.all([sha256Hex(body), sha256Hex(document)]);

  await putIfAbsent(ctx.env.BODIES, bodyKey(rawHash), body);
  await putIfAbsent(ctx.env.BODIES, normalizedKey(docHash), document);

  const snapshotId = crypto.randomUUID();
  const fetchedAtIso = new Date(ctx.now()).toISOString();
  const snapshot = await createSnapshot(ctx.db, {
    id: snapshotId,
    monitorId: ctx.monitor.id,
    targetId: target.id,
    checkAttemptId,
    fetchedAt: fetchedAtIso,
    httpStatus: outcome.status,
    contentType: outcome.contentType,
    etag: outcome.etag,
    lastModified: outcome.lastModified,
    bodyHash: rawHash,
    r2Key: bodyKey(rawHash),
    normalizedHash: docHash,
    normalizedR2Key: normalizedKey(docHash),
    textHash: docHash,
    normalizationVersion: SITEMAP_DOCUMENT_VERSION,
  });

  // 初回チェック (baseline): URL集合ドキュメントの snapshot を記録するだけで Change は
  // 一切作らない (ADR-0010 「3. 増分のみを配信する」、feed.ts の baseline 判定と同じ意図)。
  // previousSnapshot が無い場合に加え、monitor 自体が初回チェック中の場合も baseline とする
  // (feed.ts processFeedItems の isBaselineCheck 判定と同一の安定性根拠: ctx.monitor は
  // runMonitorCheck 冒頭で読み込まれたきりで lastCheckedAt はこのチェック中に書き換わらない)。
  const isBaselineCheck = previousSnapshot === null || ctx.monitor.lastCheckedAt === null;
  if (isBaselineCheck) return;

  // 前回と docHash が同一なら URL集合に変化なし (conditional fetch がヒットしなかった
  // 再取得等)。Change は作らない。
  if (previousSnapshot.textHash === docHash) return;

  const previousDocument = await readDocumentFromR2(ctx.env, previousSnapshot.normalizedR2Key);
  const diff = diffText(previousDocument, document);
  if (!diff.changed) return; // 保険: ドキュメントテキストとしては実質同一だった場合

  const changeId = crypto.randomUUID();
  // diffR2Key は changeId から決定論的に導出できるキーであり、insertChangeIfNew が
  // 実際に新規行を作った場合のみ後段で R2 へ put する (孤児 diff オブジェクト回避、
  // pageContent.ts と同じ理由)。
  const diffR2Key = diff.unifiedDiff ? diffKey(changeId) : null;
  const summary = `+${diff.addedCount}/-${diff.removedCount} URL`;
  const diffPreview = diff.unifiedDiff ? `${summary}\n${truncateDiffPreview(diff.unifiedDiff)}` : summary;

  const inserted = await insertChangeIfNew(ctx.db, {
    id: changeId,
    monitorId: ctx.monitor.id,
    targetId: target.id,
    targetUrl: target.url,
    kind: 'updated',
    diffLevel: 'text_hash',
    dedupeKey: docHash,
    previousSnapshotId: previousSnapshot.id,
    snapshotId: snapshot.id,
    diffR2Key,
    diffPreview,
    title: summary,
    detectedAt: fetchedAtIso,
  });

  if (inserted.inserted && diffR2Key) {
    await ctx.env.BODIES.put(diffR2Key, diff.unifiedDiff);
  }

  // 配送 (fanout) と changeIds 追加は Notify段 (notifyDetectedChanges) に委ねる。Sitemap Direct は
  // 1チェックにつき Change 高々1件のため、DetectedChange 1要素の配列として渡す。snapshotベースの
  // 差分検知で watermark を持たないため watermarkAdvance は不要。at-least-once 復旧の順序
  // (inserted の真偽に関わらず fanout → inserted のときだけ changeIds) は Notify段が保証する。
  await notifyDetectedChanges(ctx, [{ row: inserted.row, inserted: inserted.inserted }]);
}
