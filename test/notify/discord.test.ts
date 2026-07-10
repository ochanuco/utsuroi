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

  it('truncates an embed title longer than 256 chars (Discord API limit)', () => {
    const longTitle = 'x'.repeat(300);
    const payload = buildDiscordPayload(makeChange({ title: longTitle })) as {
      embeds: Array<{ title: string }>;
    };
    expect(payload.embeds[0]!.title.length).toBeLessThanOrEqual(256);
    expect(payload.embeds[0]!.title).not.toBe(longTitle);
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
});
