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

  it('includes siteName, title, targetUrl, detectedAt in the embed description', () => {
    const change = makeChange();
    const payload = buildDiscordPayload(change) as { embeds: Array<{ description: string }> };
    const description = payload.embeds[0]!.description;
    expect(description).toContain(change.siteName);
    expect(description).toContain(change.targetUrl);
    expect(description).toContain(change.detectedAt);
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
});
