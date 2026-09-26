import { describe, expect, it } from 'vitest';
import { buildDiscordPayload, maskWebhookUrl, sendToDiscord } from '../../src/notify/discord';
import type { ChangeSummary } from '../../src/shared/contracts';

const WEBHOOK_URL = 'https://discord.com/api/webhooks/123456789012345678/aaaaBBBBccccDDDDeeeeFFFF-secret1234';

function makeChange(overrides: Partial<ChangeSummary> = {}): ChangeSummary {
  return {
    changeId: 'change-1',
    kind: 'updated',
    sourceType: 'page',
    siteName: 'Example Site',
    monitorId: 'monitor-1',
    targetUrl: 'https://example.com/page',
    title: 'Example Page',
    detectedAt: '2026-07-10T12:00:00.000Z',
    diffPreview: null,
    ...overrides,
  };
}

describe('buildDiscordPayload', () => {
  it('produces an embeds-only payload with no content field', () => {
    const payload = buildDiscordPayload(makeChange()) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('content');
    expect(Array.isArray(payload.embeds)).toBe(true);
    expect((payload.embeds as unknown[]).length).toBe(1);
  });

  it('includes targetUrl and a JST-formatted detectedAt in the embed description, but not siteName (Site line removed)', () => {
    const change = makeChange();
    const payload = buildDiscordPayload(change) as { embeds: Array<{ description: string }> };
    const description = payload.embeds[0]!.description;
    expect(description).not.toContain(change.siteName);
    expect(description).toContain(change.targetUrl);
    expect(description).toContain('2026-07-10 21:00:00 JST');
    expect(description).not.toContain(change.detectedAt);
  });

  it('falls back to the raw string in the description and omits embed.timestamp when detectedAt is not a parseable ISO date', () => {
    const payload = buildDiscordPayload(makeChange({ detectedAt: 'not-a-date' })) as {
      embeds: Array<{ description: string; timestamp?: string }>;
    };
    expect(payload.embeds[0]!.description).toContain('not-a-date');
    expect(payload.embeds[0]!.timestamp).toBeUndefined();
  });

  it('normalizes embed.timestamp to an ISO string when detectedAt is parseable', () => {
    const payload = buildDiscordPayload(makeChange()) as {
      embeds: Array<{ timestamp?: string }>;
    };
    const timestamp = payload.embeds[0]!.timestamp;
    expect(timestamp).toBe('2026-07-10T12:00:00.000Z');
    expect(() => new Date(timestamp as string).toISOString()).not.toThrow();
  });

  it('colors embeds differently per change kind', () => {
    const colors = (['new', 'updated', 'removed'] as const).map((kind) => {
      const payload = buildDiscordPayload(makeChange({ kind })) as {
        embeds: Array<{ color: number }>;
      };
      return payload.embeds[0]!.color;
    });
    expect(new Set(colors).size).toBe(3);
  });

  it('truncates a long diffPreview to roughly 900 chars inside a code block, keeping total under 4096', () => {
    const longDiff = 'x'.repeat(5000);
    const payload = buildDiscordPayload(makeChange({ diffPreview: longDiff })) as {
      embeds: Array<{ description: string }>;
    };
    const description = payload.embeds[0]!.description;
    expect(description.length).toBeLessThanOrEqual(4096);
    expect(description).toContain('```diff');
    // 元の diff 全体がそのまま含まれていないこと (切り詰められている)
    expect(description).not.toContain(longDiff);
  });

  it('omits the diff code block when diffPreview is null', () => {
    const payload = buildDiscordPayload(makeChange({ diffPreview: null })) as {
      embeds: Array<{ description: string }>;
    };
    expect(payload.embeds[0]!.description).not.toContain('```');
  });

  it('truncates an embed title longer than 256 chars (Discord API limit)', () => {
    const longTitle = 'x'.repeat(300);
    const payload = buildDiscordPayload(makeChange({ title: longTitle })) as {
      embeds: Array<{ title: string }>;
    };
    expect(payload.embeds[0]!.title.length).toBeLessThanOrEqual(256);
    expect(payload.embeds[0]!.title).not.toBe(longTitle);
  });

  // labels機能 (ADR-0019): 'new' は種別行を省き、それ以外は残す。タグ行は種別行の直後・URL行の前に載る。
  describe('種別行 / タグ行 (labels機能)', () => {
    it('omits the 種別 line for a "new" change', () => {
      const payload = buildDiscordPayload(makeChange({ kind: 'new' })) as {
        embeds: Array<{ description: string }>;
      };
      expect(payload.embeds[0]!.description).not.toContain('種別');
    });

    it('keeps the 種別 line for an "updated" change', () => {
      const payload = buildDiscordPayload(makeChange({ kind: 'updated' })) as {
        embeds: Array<{ description: string }>;
      };
      expect(payload.embeds[0]!.description).toContain('**種別**: 更新検出');
    });

    it('keeps the 種別 line for a "removed" change', () => {
      const payload = buildDiscordPayload(makeChange({ kind: 'removed' })) as {
        embeds: Array<{ description: string }>;
      };
      expect(payload.embeds[0]!.description).toContain('**種別**: 削除検出');
    });

    it('omits tag lines when tagLines is empty/undefined', () => {
      const payload = buildDiscordPayload(makeChange({ tagLines: [] })) as {
        embeds: Array<{ description: string }>;
      };
      const description = payload.embeds[0]!.description;
      expect(description).not.toContain('分類');
    });

    it('renders one line per tag group, joining values with 、, placed before URL', () => {
      const payload = buildDiscordPayload(
        makeChange({
          kind: 'updated',
          tagLines: [
            { heading: 'エリア', values: ['くずは', '市駅周辺'] },
            { heading: '話題', values: ['賃貸'] },
          ],
        }),
      ) as { embeds: Array<{ description: string }> };
      const description = payload.embeds[0]!.description;
      expect(description).toContain('**エリア**: くずは、市駅周辺');
      expect(description).toContain('**話題**: 賃貸');

      const kindIdx = description.indexOf('**種別**');
      const areaIdx = description.indexOf('**エリア**');
      const urlIdx = description.indexOf('**URL**');
      expect(kindIdx).toBeGreaterThanOrEqual(0);
      expect(kindIdx).toBeLessThan(areaIdx);
      expect(areaIdx).toBeLessThan(urlIdx);
    });
  });
});

describe('maskWebhookUrl', () => {
  it('does not include the raw webhook path/token', () => {
    const masked = maskWebhookUrl(WEBHOOK_URL);
    expect(masked).not.toContain('123456789012345678');
    expect(masked).not.toContain('aaaaBBBBccccDDDDeeeeFFFF-secret1234');
  });

  it('keeps the host and last 4 chars for operator identification', () => {
    const masked = maskWebhookUrl(WEBHOOK_URL);
    expect(masked).toContain('discord.com');
    expect(masked).toContain('1234'); // last 4 chars of the url
  });
});

describe('sendToDiscord', () => {
  it('treats 204 as success', async () => {
    const fetchStub = async () => new Response(null, { status: 204 });
    const result = await sendToDiscord(WEBHOOK_URL, {}, { fetch: fetchStub });
    expect(result).toEqual({ ok: true });
  });

  it('treats 200 as success', async () => {
    const fetchStub = async () => new Response(null, { status: 200 });
    const result = await sendToDiscord(WEBHOOK_URL, {}, { fetch: fetchStub });
    expect(result).toEqual({ ok: true });
  });

  it('extracts retryAfterSeconds from the Retry-After header on 429', async () => {
    const fetchStub = async () =>
      new Response(null, { status: 429, headers: { 'retry-after': '7' } });
    const result = await sendToDiscord(WEBHOOK_URL, {}, { fetch: fetchStub });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.retryAfterSeconds).toBe(7);
      expect(result.message).not.toContain(WEBHOOK_URL);
    }
  });

  it('falls back to JSON body retry_after when there is no Retry-After header', async () => {
    const fetchStub = async () =>
      new Response(JSON.stringify({ retry_after: 3.5, message: 'rate limited' }), {
        status: 429,
      });
    const result = await sendToDiscord(WEBHOOK_URL, {}, { fetch: fetchStub });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryAfterSeconds).toBe(3.5);
    }
  });

  it('classifies 5xx as a retryable failure without leaking the webhook URL', async () => {
    const fetchStub = async () => new Response('server error', { status: 503 });
    const result = await sendToDiscord(WEBHOOK_URL, {}, { fetch: fetchStub });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.message).not.toContain(WEBHOOK_URL);
    }
  });

  it('classifies 404 as a permanent failure without leaking the webhook URL', async () => {
    const fetchStub = async () => new Response('unknown webhook', { status: 404 });
    const result = await sendToDiscord(WEBHOOK_URL, {}, { fetch: fetchStub });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.message).not.toContain(WEBHOOK_URL);
    }
  });

  it('reports network errors as a retryable failure (status null) without leaking the webhook URL', async () => {
    const fetchStub = async () => {
      throw new TypeError('fetch failed: network unreachable');
    };
    const result = await sendToDiscord(WEBHOOK_URL, {}, { fetch: fetchStub });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBeNull();
      expect(result.message).not.toContain(WEBHOOK_URL);
    }
  });

  it('does not leak exception details or response body fragments in the persisted message', async () => {
    const fetchStub = async () => {
      throw new Error('DNS lookup failed for internal-host.local: super secret detail');
    };
    const networkErrorResult = await sendToDiscord(WEBHOOK_URL, {}, { fetch: fetchStub });
    expect(networkErrorResult.ok).toBe(false);
    if (!networkErrorResult.ok) {
      expect(networkErrorResult.message).not.toContain('super secret detail');
    }

    const bodyLeakStub = async () => new Response('super secret response body detail', { status: 500 });
    const serverErrorResult = await sendToDiscord(WEBHOOK_URL, {}, { fetch: bodyLeakStub });
    expect(serverErrorResult.ok).toBe(false);
    if (!serverErrorResult.ok) {
      expect(serverErrorResult.message).not.toContain('super secret response body detail');
    }
  });

  it('rejects a webhook host that is not a Discord domain, even when the SSRF policy would allow it', async () => {
    let fetchCalled = false;
    const fetchStub = async () => {
      fetchCalled = true;
      return new Response(null, { status: 204 });
    };

    const result = await sendToDiscord('https://evil.example.com/webhook', {}, { fetch: fetchStub });

    expect(fetchCalled).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).not.toBeNull();
      expect(result.message).not.toContain('evil.example.com');
    }
  });

  it('revalidates the webhook URL against the SSRF policy immediately before sending', async () => {
    let fetchCalled = false;
    const fetchStub = async () => {
      fetchCalled = true;
      return new Response(null, { status: 204 });
    };

    const result = await sendToDiscord('http://127.0.0.1/webhook', {}, { fetch: fetchStub });

    expect(fetchCalled).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).not.toBeNull();
      expect(result.message).not.toContain('127.0.0.1');
    }
  });

  // ADR-0019: Destination.thread_id が設定されている場合、配送 URL に ?thread_id= を付ける。
  describe('thread_id (ADR-0019)', () => {
    it('appends thread_id as a query parameter when set', async () => {
      let requestedUrl: string | null = null;
      const fetchStub = async (input: RequestInfo | URL) => {
        requestedUrl = typeof input === 'string' ? input : input.toString();
        return new Response(null, { status: 204 });
      };

      const result = await sendToDiscord(WEBHOOK_URL, {}, { fetch: fetchStub, threadId: '123456789012345678' });

      expect(result.ok).toBe(true);
      expect(requestedUrl).toBe(`${WEBHOOK_URL}?thread_id=123456789012345678`);
    });

    it('preserves an existing query string when adding thread_id', async () => {
      let requestedUrl: string | null = null;
      const fetchStub = async (input: RequestInfo | URL) => {
        requestedUrl = typeof input === 'string' ? input : input.toString();
        return new Response(null, { status: 204 });
      };

      const result = await sendToDiscord(`${WEBHOOK_URL}?wait=true`, {}, {
        fetch: fetchStub,
        threadId: '123456789012345678',
      });

      expect(result.ok).toBe(true);
      expect(requestedUrl).toContain('wait=true');
      expect(requestedUrl).toContain('thread_id=123456789012345678');
    });

    it('does not add a thread_id query parameter when threadId is null/omitted', async () => {
      let requestedUrl: string | null = null;
      const fetchStub = async (input: RequestInfo | URL) => {
        requestedUrl = typeof input === 'string' ? input : input.toString();
        return new Response(null, { status: 204 });
      };

      await sendToDiscord(WEBHOOK_URL, {}, { fetch: fetchStub, threadId: null });

      expect(requestedUrl).toBe(WEBHOOK_URL);
      expect(requestedUrl).not.toContain('thread_id');
    });
  });
});
