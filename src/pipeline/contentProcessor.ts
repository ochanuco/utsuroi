/**
 * Source 種別ごとの内容処理 (Content Processor) を1つの共通インターフェースに揃え、
 * Source→Processor のレシピ解決を1箇所に集約する (ADR-0016 Step 2)。
 * runCheck.ts に埋まっていた if/else ディスパッチをここへ移すだけで、各 process* 関数の
 * シグネチャ・中身は一切変更しない (下の adapter は薄いラップのみ)。
 */
import type { FetchSuccess } from '../shared/contracts';
import type { SnapshotRow, SourceRow, TargetRow } from '../db';
import type { CheckContext } from './types';
import { processPageContent } from './pageContent';
import { processPageItems } from './pageItems';
import { processSitemapDirect } from './sitemapDirect';
import { processSitemapTraversal } from './sitemapTraversal';
import { processFeedContent } from './feed';

/**
 * 内容処理 (Content Processor) 共通入力。Source URL 本体の fetch が成功し body が得られた後、
 * Source 種別ごとの内容処理へ渡す一式。個々の Processor は必要なフィールドだけを使う
 * (例: previousSnapshot は本文差分系 processPageContent / processSitemapDirect のみ参照)。
 * ADR-0016: runCheck の Source 種別 if/else ディスパッチを、この型を受ける Processor の
 * レシピ解決1箇所へ集約するための共通契約。
 */
export interface ContentInput {
  target: TargetRow;
  previousSnapshot: SnapshotRow | null;
  checkAttemptId: string | null;
  outcome: FetchSuccess;
  body: Uint8Array;
}

export type ContentProcessor = (ctx: CheckContext, input: ContentInput) => Promise<void>;

/**
 * Source 種別 + config から内容処理 Processor を1つ解決する (ADR-0016 レシピ表)。
 * 分岐条件は従来 runCheck.ts に埋まっていた if/else と同一:
 * - page: pageMode==='extract' なら アイテム抽出、既定は本文差分
 * - sitemap / sitemap-index: sitemapMode==='traverse' なら探索、既定は Direct
 * - それ以外 (rss/atom): feed 本文処理
 */
export function resolveContentProcessor(source: SourceRow): ContentProcessor {
  if (source.type === 'page') {
    return source.config?.pageMode === 'extract' ? pageItemsProcessor : pageContentProcessor;
  }
  if (source.type === 'sitemap' || source.type === 'sitemap-index') {
    return source.config?.sitemapMode === 'traverse' ? sitemapTraversalProcessor : sitemapDirectProcessor;
  }
  return feedContentProcessor;
}

const pageContentProcessor: ContentProcessor = (ctx, i) =>
  processPageContent(ctx, i.target, i.previousSnapshot, i.checkAttemptId, i.outcome, i.body);
const pageItemsProcessor: ContentProcessor = (ctx, i) =>
  processPageItems(ctx, i.target, i.checkAttemptId, i.outcome, i.body);
const sitemapDirectProcessor: ContentProcessor = (ctx, i) =>
  processSitemapDirect(ctx, i.target, i.previousSnapshot, i.checkAttemptId, i.outcome, i.body);
const sitemapTraversalProcessor: ContentProcessor = (ctx, i) =>
  processSitemapTraversal(ctx, i.target, i.checkAttemptId, i.outcome, i.body);
const feedContentProcessor: ContentProcessor = (ctx, i) =>
  processFeedContent(ctx, i.target, i.checkAttemptId, i.outcome, i.body);
