/**
 * Discord Webhook 配送ロジック。
 * SPEC §14 / ADR-0007。webhook URL は決してログ・error message に平文で含めない。
 */
import type { ChangeSummary, DiscordSendResult } from '../shared/contracts';
import { checkUrlForSsrf } from '../net';

/** SSRF ポリシーで拒否された webhook URL への送信を表す合成ステータス (実HTTPレスポンスではない) */
const SSRF_BLOCKED_STATUS = 400;

/** diffPreview を code block へ収める際の目標上限文字数 */
const DIFF_PREVIEW_MAX_CHARS = 900;

/** Discord embed description の上限 (Discord API 仕様) */
const EMBED_DESCRIPTION_MAX = 4096;

/** Discord embed title の上限 (Discord API 仕様) */
const EMBED_TITLE_MAX = 256;

const KIND_LABEL: Record<ChangeSummary['kind'], string> = {
  new: '新規検出',
  updated: '更新検出',
  removed: '削除検出',
};

/** kind ごとの embed 色 (Discord ブランドカラー準拠) */
const KIND_COLOR: Record<ChangeSummary['kind'], number> = {
  new: 0x57f287, // green
  updated: 0xfee75c, // yellow
  removed: 0xed4245, // red
};

function truncateDiffPreview(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  return `${diff.slice(0, maxChars)}\n…(truncated)`;
}

/** 文字列を指定長で切り詰める。切り詰めた場合は末尾に省略記号を付ける */
function truncateToLength(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Discord Webhook Embed ペイロードを生成する。
 * content は使わず embeds のみを載せる。
 */
export function buildDiscordPayload(change: ChangeSummary): object {
  const lines = [
    `**Site**: ${change.siteName}`,
    `**種別**: ${KIND_LABEL[change.kind]}`,
    `**URL**: ${change.targetUrl}`,
    `**検出日時**: ${change.detectedAt}`,
  ];

  if (change.diffPreview) {
    const truncatedDiff = truncateDiffPreview(change.diffPreview, DIFF_PREVIEW_MAX_CHARS);
    lines.push('```diff', truncatedDiff, '```');
  }

  const description = truncateToLength(lines.join('\n'), EMBED_DESCRIPTION_MAX);

  const embed: Record<string, unknown> = {
    title: truncateToLength(change.title ?? change.siteName, EMBED_TITLE_MAX),
    color: KIND_COLOR[change.kind],
    description,
    timestamp: change.detectedAt,
  };

  return { embeds: [embed] };
}

/**
 * Webhook URL をログ・error message 用にマスクする。
 * host 名 + 末尾4文字のみを残す (SPEC §14「平文表示しない」)。
 */
export function maskWebhookUrl(url: string): string {
  const tail = url.slice(-4);
  try {
    const parsed = new URL(url);
    return `${parsed.host}/***${tail}`;
  } catch {
    return `***${tail}`;
  }
}

/** Retry-After ヘッダ、なければ JSON body の retry_after を読む */
async function extractRetryAfterSeconds(res: Response): Promise<number | null> {
  const header = res.headers.get('retry-after');
  if (header !== null) {
    const parsedHeader = Number(header);
    if (Number.isFinite(parsedHeader) && parsedHeader >= 0) return parsedHeader;
  }

  try {
    const json: unknown = await res.json();
    if (json !== null && typeof json === 'object' && 'retry_after' in json) {
      const value = (json as Record<string, unknown>).retry_after;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    }
  } catch {
    // body が JSON でない、または読み取り失敗。ヘッダ無しなら null。
  }

  return null;
}

/**
 * Discord Webhook へ payload を POST する。
 * 200/204 は成功。429 は Retry-After を尊重して retryAfterSeconds に反映。
 * 5xx・ネットワークエラーはリトライ可能失敗、429以外の4xxは permanent 失敗として返す。
 *
 * 永続化される message は固定文言 + status のみとし、例外詳細やレスポンス本文の
 * 断片は含めない (webhook URL 漏えい防止。仮に URL がエラー本文に反映されるような
 * サービスであっても、そのボディを保存しないため安全側に倒す)。
 */
export async function sendToDiscord(
  webhookUrl: string,
  payload: object,
  opts?: { fetch?: typeof fetch },
): Promise<DiscordSendResult> {
  // 送信直前の再検証 (登録時だけでなく送信時にも SSRF ポリシーを適用する, SPEC §15)。
  // 拒否は permanent failure 扱いとする (リトライしても結果は変わらないため)。
  const ssrf = checkUrlForSsrf(webhookUrl);
  if (!ssrf.allowed) {
    return {
      ok: false,
      status: SSRF_BLOCKED_STATUS,
      retryAfterSeconds: null,
      message: 'discord webhook delivery failed: webhook url blocked by url safety policy',
    };
  }

  const doFetch = opts?.fetch ?? fetch;

  let res: Response;
  try {
    res = await doFetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return {
      ok: false,
      status: null,
      retryAfterSeconds: null,
      message: 'discord webhook delivery failed: network error',
    };
  }

  if (res.status === 200 || res.status === 204) {
    return { ok: true };
  }

  if (res.status === 429) {
    const retryAfterSeconds = await extractRetryAfterSeconds(res);
    return {
      ok: false,
      status: 429,
      retryAfterSeconds,
      message: 'discord webhook delivery rate limited (429)',
    };
  }

  return {
    ok: false,
    status: res.status,
    retryAfterSeconds: null,
    message: `discord webhook delivery failed: unexpected status ${res.status}`,
  };
}
