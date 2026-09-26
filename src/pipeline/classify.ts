/**
 * Classify段 (ADR-0019): Source config の `classify` に基づき、Detect段が検知した Change に
 * タグを付ける。Enrich段の直後・Notify段の直前に呼ばれる (feed.ts の processFeedItems 参照)。
 *
 * config.classify が未設定の Source では何もしない (tags は挿入時のまま NULL を維持する)。
 * 設定済みの Source では、既に分類済み (row.tags !== null) の Change を除き、決定論ルールで
 * タグを計算して永続化する — dedupeKey 重複によるリトライ (inserted:false) で tags が既に
 * 設定されている Change は再分類しない (同じ Change の宛先が再試行のたびに変わらないようにするため)。
 *
 * 失敗はすべて非致死: 1件の分類エラー (正規表現コンパイル失敗等、通常は API 層の検証で
 * 弾かれるため到達しないはずだが防御的に扱う) は console.warn してスキップするのみで、
 * この関数から例外を漏らさない (Notify段を止めないため)。
 */
import { setChangeTagsIfNull } from '../db';
import type { SourceConfig } from '../db';
import type { DetectedChange } from './notify';
import type { CheckContext } from './types';

/** Classify ルールの照合に使う Item 側の値 (Detect段が運んだ FeedItem + enrich後の title) */
export interface ClassifyMatchInput {
  title: string | null;
  url: string | null;
  summary: string | null;
  fields?: Array<{ name: string; value: string }>;
}

/** フィールド値をルールへ渡す前に切り詰める上限文字数 (巨大な summary/fields 対策) */
const FIELD_VALUE_MAX_CHARS = 2000;

/** 'title' | 'url' | 'summary' は Item 自身のプロパティ、それ以外は extract.fields[].name を探す */
function resolveFieldValue(input: ClassifyMatchInput, field: string): string | null {
  if (field === 'title') return input.title;
  if (field === 'url') return input.url;
  if (field === 'summary') return input.summary;
  return input.fields?.find((f) => f.name === field)?.value ?? null;
}

/**
 * classify.rules を順に評価し、一致した全ルールの tag を (重複除去・ルール順維持で) 返す。
 * 一致が無く default_tag が設定されていれば [default_tag] を返す。API 層 (sources.ts) が
 * classify.rules[].match.pattern の compile 可能性を作成/更新時に検証済みだが、ここでも
 * 個別に try/catch し、想定外の不正パターンで Change 全体の分類が落ちないようにする。
 */
export function computeTags(
  classify: NonNullable<SourceConfig['classify']>,
  input: ClassifyMatchInput,
): string[] {
  const tags: string[] = [];
  for (const rule of classify.rules) {
    const rawValue = resolveFieldValue(input, rule.match.field);
    if (rawValue === null) continue;
    const value = rawValue.length > FIELD_VALUE_MAX_CHARS ? rawValue.slice(0, FIELD_VALUE_MAX_CHARS) : rawValue;

    let regex: RegExp;
    try {
      regex = new RegExp(rule.match.pattern, rule.match.flags ?? '');
    } catch {
      continue;
    }

    if (regex.test(value) && !tags.includes(rule.tag)) {
      tags.push(rule.tag);
    }
  }

  if (tags.length === 0 && classify.defaultTag) {
    return [classify.defaultTag];
  }
  return tags;
}

/**
 * detected のうち tags が未確定 (row.tags === null) の Change だけを対象にタグを計算・永続化する。
 * config.classify が無い Source は何もしない (tags は NULL のまま)。
 */
export async function classifyDetectedChanges(ctx: CheckContext, detected: DetectedChange[]): Promise<void> {
  const classify = ctx.source.config?.classify;
  if (!classify) return;

  for (const d of detected) {
    if (d.row.tags !== null) continue;

    try {
      const input: ClassifyMatchInput = {
        // title は enrich 段で書き戻された可能性があるため row 側を優先する。
        title: d.row.title ?? d.item?.title ?? null,
        url: d.item?.url ?? null,
        summary: d.item?.summary ?? null,
        fields: d.item?.fields,
      };
      const tags = computeTags(classify, input);
      d.row.tags = await setChangeTagsIfNull(ctx.db, d.row.id, tags);
    } catch (err) {
      console.warn(
        `[classify] monitor=${ctx.monitor.id} change=${d.row.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
