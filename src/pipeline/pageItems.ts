/**
 * page Source の「新着検知」(アイテム抽出) モード内容処理 (ADR-0011, ROADMAP Phase 2
 * Processor の最初の具体化)。
 *
 * config.pageMode === 'extract' の page Source が到達する経路 (既定の 'content' モードは
 * 従来どおり src/pipeline/pageContent.ts の processPageContent が処理する。ディスパッチ判定は
 * runCheck.ts を参照)。
 *
 * 設計判断: アイテムの new/updated 検知・Target化・通知ファンアウトは実装済みの
 * processFeedItems (feed.ts, rss/atom/sitemap 共通の実URL処理コア) にそのまま委譲し、ここでは
 * 再実装しない。sitemapTraversal.ts (ADR-0010 Phase B) も同じ理由で processFeedItems を再利用
 * しており、本モジュールも同じ設計方針を踏襲する。processFeedItems は既に baseline 判定
 * (初回チェックは Change を作らない)・MAX_FEED_ITEMS_PER_CHECK による打ち切り・dedupeKey による
 * 冪等 upsert・通知ファンアウトを一式持っている。
 *
 * v1 スコープ: extractItems (src/normalize/extractItems.ts) は publishedAt/updatedAt を持たない
 * (HTML から更新時刻を得る一般的な手段が無いため)。そのため processFeedItems 側の 'updated'
 * 検知 (item.updatedAt と watermark の比較) はこの経路では発火せず、常に 'new' のみが検知される
 * (ADR-0011 参照)。将来、アイテムのテキストhashを watermark として使う「擬似 updated」検知を
 * 追加する余地はあるが、v1では扱わない。
 *
 * 抽出0件の扱い: HTML構造の変化やセレクタの陳腐化により、以前は抽出できていたページが
 * 突然0件になるケースを継続的に検知する仕組み (異常検知) は v1 のスコープ外。今回は
 * console.warn で件数を記録するのみに留め、将来課題として明記する。
 *
 * 構造化フィールド抽出 (extract.fields, ADR-0013): extractItems が返す ExtractedItem.fields
 * (価格・所在地等、設定順・未マッチは省く) を「名前: 値」の行形式に整形して FeedItem.summary に
 * 載せる (0件なら null)。processFeedItems には summaryAsDiffPreview:true を渡し、'new'/'updated'
 * いずれの Change でも summary を diff_preview として書かせる — pageItems 経由の呼び出しだけが
 * この opt-in を有効にする (rss/atom 等、他の呼び出し元の通知内容は変更しない)。
 */
import { sha256Hex } from '../shared/hash';
import { extractItems } from '../normalize/extractItems';
import { extractCharsetFromContentType } from '../normalize';
import type { FeedItem, FetchSuccess } from '../shared/contracts';
import { createSnapshot, type TargetRow } from '../db';
import { bodyKey, putIfAbsent } from './r2';
import { processFeedItems } from './feed';
import type { CheckContext } from './types';

/** ExtractedItem.fields を「名前: 値」の行形式に整形する。0件なら null (SPEC: summary は任意) */
function formatFieldsAsSummary(fields: Array<{ name: string; value: string }>): string | null {
  if (fields.length === 0) return null;
  return fields.map((f) => `${f.name}: ${f.value}`).join('\n');
}

export async function processPageItems(
  ctx: CheckContext,
  target: TargetRow,
  checkAttemptId: string | null,
  outcome: FetchSuccess,
  body: Uint8Array,
): Promise<void> {
  const rawHash = await sha256Hex(body);
  await putIfAbsent(ctx.env.BODIES, bodyKey(rawHash), body);

  const extractConfig = ctx.source.config?.extract;
  if (!extractConfig) {
    // config.pageMode === 'extract' の Source は API 作成時に extract.item_selector を必須と
    // している (src/api/routes/sources.ts) ため、通常は到達しない防御的分岐。DB を直接編集した
    // 等の想定外ケースでチェック全体を失敗させないよう、警告を出して何もせず終える。
    console.warn(
      `[pageItems] processPageItems: monitor=${ctx.monitor.id} source=${ctx.source.id} pageMode=extract だが ` +
        `config.extract が無いためアイテム抽出をスキップします`,
    );
    return;
  }

  const extracted = await extractItems(body, {
    itemSelector: extractConfig.itemSelector,
    linkSelector: extractConfig.linkSelector,
    titleSelector: extractConfig.titleSelector,
    // リダイレクトを経た場合、相対リンクは最終到達URLを基準に解決される必要がある
    // (ctx.source.url ではなく outcome.finalUrl を使う。レビュー指摘)。
    baseUrl: outcome.finalUrl,
    headerCharset: extractCharsetFromContentType(outcome.contentType),
    fields: extractConfig.fields,
  });

  if (extracted.length === 0) {
    console.warn(
      `[pageItems] processPageItems: monitor=${ctx.monitor.id} source=${ctx.source.id} itemSelector=` +
        `${JSON.stringify(extractConfig.itemSelector)} で抽出されたアイテムが0件でした ` +
        `(セレクタの陳腐化・ページ構造変化の可能性。継続的な0件検知はv1スコープ外)`,
    );
    // 抽出0件でも Snapshot は下で記録する (フェッチ自体は成功しており、etag/lastModified を
    // 保存しないと次回も全文を取り直すことになるため)。
  } else {
    // ExtractedItem.fields (ADR-0013) を summary へ整形した FeedItem に変換してから
    // processFeedItems へ渡す (fields 自体は FeedItem の契約に無いフィールドのため、
    // 下流へそのまま持ち込まず summary の形で1回だけ変換する)。
    const items: FeedItem[] = extracted.map((item) => ({
      stableKey: item.stableKey,
      url: item.url,
      title: item.title,
      publishedAt: item.publishedAt,
      updatedAt: item.updatedAt,
      summary: formatFieldsAsSummary(item.fields),
    }));
    await processFeedItems(ctx, items, undefined, { summaryAsDiffPreview: true });
  }

  // Snapshot (etag/lastModified を含む条件付きリクエストのメタデータ) は、アイテム処理が
  // 完了した後にのみ記録する。先に記録すると、extractItems/processFeedItems が途中で throw
  // した場合でも次回チェックが 304 (Not Modified) でスキップされてしまい、未処理のアイテムが
  // 本文が次に変わるまで永久に失われる (at-least-once の破れ、レビュー指摘)。
  // pageContent.ts (本文差分モード) と同じフィールド規約。本モードは normalizeHtml (全文正規化)
  // を行わないため normalizedHash/normalizedR2Key/textHash は持たない。
  await createSnapshot(ctx.db, {
    monitorId: ctx.monitor.id,
    targetId: target.id,
    checkAttemptId,
    fetchedAt: new Date(ctx.now()).toISOString(),
    httpStatus: outcome.status,
    contentType: outcome.contentType,
    etag: outcome.etag,
    lastModified: outcome.lastModified,
    bodyHash: rawHash,
    r2Key: bodyKey(rawHash),
  });
}
