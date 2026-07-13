/**
 * Source 種別ごとの内容処理 (Content Processor) を1つの共通インターフェースに揃え、
 * Source→Processor のレシピ解決を1箇所に集約する (ADR-0016 Step 2)。
 * runCheck.ts に埋まっていた if/else ディスパッチをここへ移すだけで、各 process* 関数の
 * シグネチャ・中身は一切変更しない (下の adapter は薄いラップのみ)。
 * ADR-0016 パイプライン可視化 (バックエンド側 PR-A): レシピ解決を RECIPES テーブルに集約し、
 * 実行時の processor と可視化用の Stage 列 (describePipeline) を同じ定義から引くことで、
 * 「実際に走る処理」と「画面に見せる図」がズレない single source of truth を保つ。
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

/** パイプライン可視化用の Stage 記述 (ADR-0016)。id は安定キー(CSS/テスト用)、label は日本語表示名。 */
export interface PipelineStage {
  id: string;
  label: string;
}

/**
 * Source 種別 + config から決まるレシピ (ADR-0016 レシピ表)。
 * processor (実行時の内容処理) と stages (可視化用の宣言的 Stage 列) を同じ定義から引くことで、
 * 「実際に走る処理」と「画面に見せる図」がズレない single source of truth を保つ。
 */
const RECIPES = {
  'page:extract': {
    processor: pageItemsProcessor,
    stages: [
      { id: 'fetch', label: '取得' },
      { id: 'extract', label: '抽出' },
      { id: 'diff', label: '差分検知' },
      { id: 'notify', label: '通知' },
    ],
  },
  'page:content': {
    processor: pageContentProcessor,
    stages: [
      { id: 'fetch', label: '取得' },
      { id: 'content-diff', label: '本文差分' },
      { id: 'notify', label: '通知' },
    ],
  },
  'sitemap:traverse': {
    processor: sitemapTraversalProcessor,
    stages: [
      { id: 'traverse', label: 'sitemap探索' },
      { id: 'diff', label: '差分検知' },
      { id: 'notify', label: '通知' },
    ],
  },
  'sitemap:direct': {
    processor: sitemapDirectProcessor,
    stages: [
      { id: 'fetch', label: '取得' },
      { id: 'sitemap-diff', label: 'URL集合差分' },
      { id: 'notify', label: '通知' },
    ],
  },
  feed: {
    processor: feedContentProcessor,
    stages: [
      { id: 'fetch', label: '取得' },
      { id: 'extract', label: '抽出' },
      { id: 'diff', label: '差分検知' },
      { id: 'notify', label: '通知' },
    ],
  },
} satisfies Record<string, { processor: ContentProcessor; stages: PipelineStage[] }>;

type RecipeKey = keyof typeof RECIPES;

/**
 * source から使用レシピのキーを1箇所で判定する (resolveContentProcessor と describePipeline が共有)。
 * 分岐条件は従来 runCheck.ts に埋まっていた if/else と同一:
 * - page: pageMode==='extract' なら アイテム抽出、既定は本文差分
 * - sitemap / sitemap-index: sitemapMode==='traverse' なら探索、既定は Direct
 * - それ以外 (rss/atom): feed 本文処理
 */
function resolveRecipeKey(source: SourceRow): RecipeKey {
  if (source.type === 'page') {
    return source.config?.pageMode === 'extract' ? 'page:extract' : 'page:content';
  }
  if (source.type === 'sitemap' || source.type === 'sitemap-index') {
    return source.config?.sitemapMode === 'traverse' ? 'sitemap:traverse' : 'sitemap:direct';
  }
  return 'feed'; // rss / atom
}

/**
 * Source 種別 + config から内容処理 Processor を1つ解決する (ADR-0016 レシピ表)。
 * 分岐条件の詳細は resolveRecipeKey のコメント参照。
 */
export function resolveContentProcessor(source: SourceRow): ContentProcessor {
  return RECIPES[resolveRecipeKey(source)].processor;
}

/** source が実行するパイプラインの Stage 列を返す (可視化用、ADR-0016)。実行時の processor と同じレシピ由来。 */
export function describePipeline(source: SourceRow): PipelineStage[] {
  return RECIPES[resolveRecipeKey(source)].stages;
}
