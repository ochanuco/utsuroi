import { describe, expect, it } from 'vitest';
import { compareSnapshots, diffText, normalizeHtml } from '../../src/normalize';
import type { NormalizedContent } from '../../src/shared/contracts';

function toBytes(html: string): Uint8Array {
  return new TextEncoder().encode(html);
}

const baseUrl = 'https://example.com/page';

describe('diffText', () => {
  it('returns changed: false and empty unifiedDiff for identical text', () => {
    const result = diffText('line1\nline2\n', 'line1\nline2\n');
    expect(result.changed).toBe(false);
    expect(result.unifiedDiff).toBe('');
    expect(result.addedCount).toBe(0);
    expect(result.removedCount).toBe(0);
  });

  it('produces a unified diff and counts added/removed lines', () => {
    const before = 'line1\nline2\nline3\n';
    const after = 'line1\nlineTWO\nline3\nline4\n';
    const result = diffText(before, after);
    expect(result.changed).toBe(true);
    expect(result.unifiedDiff).toContain('@@');
    expect(result.unifiedDiff).toContain('-line2');
    expect(result.unifiedDiff).toContain('+lineTWO');
    expect(result.unifiedDiff).toContain('+line4');
    expect(result.addedCount).toBeGreaterThanOrEqual(2); // lineTWO + line4
    expect(result.removedCount).toBeGreaterThanOrEqual(1); // line2
  });

  it('respects the context option', () => {
    const before = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n';
    const after = before.replace('line5', 'lineFIVE');
    const wideContext = diffText(before, after, { context: 5 });
    const narrowContext = diffText(before, after, { context: 0 });
    // Wider context should produce a longer unified diff body.
    expect(wideContext.unifiedDiff.length).toBeGreaterThan(narrowContext.unifiedDiff.length);
  });
});

describe('compareSnapshots', () => {
  async function snapshot(html: string): Promise<NormalizedContent> {
    return normalizeHtml(toBytes(html), { baseUrl });
  }

  it('changed: false, level: null when raw is identical', async () => {
    const html = `<html><body><p>Hello</p></body></html>`;
    const before = await snapshot(html);
    const after = await snapshot(html);
    expect(compareSnapshots(before, after)).toEqual({ changed: false, level: null });
  });

  it('changed: false, level: null when raw differs but normalized content is equivalent', async () => {
    // Only a nonce attribute (a dynamic attribute) differs at the byte level.
    const before = await snapshot(
      `<html><body><script nonce="AAA">void 0</script><p>Hello</p></body></html>`,
    );
    const after = await snapshot(
      `<html><body><script nonce="BBB">void 0</script><p>Hello</p></body></html>`,
    );
    expect(before.rawHash).not.toBe(after.rawHash);
    expect(compareSnapshots(before, after)).toEqual({ changed: false, level: null });
  });

  it('changed: true, level: normalized_hash when markup changes but extracted text is the same', async () => {
    const before = await snapshot(`<html><body><p>Hello</p></body></html>`);
    const after = await snapshot(`<html><body><div>Hello</div></body></html>`);
    expect(before.textHash).toBe(after.textHash);
    expect(before.normalizedHash).not.toBe(after.normalizedHash);
    expect(compareSnapshots(before, after)).toEqual({ changed: true, level: 'normalized_hash' });
  });

  it('changed: true, level: text_hash when the extracted text itself changes', async () => {
    const before = await snapshot(`<html><body><p>Hello</p></body></html>`);
    const after = await snapshot(`<html><body><p>Goodbye</p></body></html>`);
    expect(before.textHash).not.toBe(after.textHash);
    expect(compareSnapshots(before, after)).toEqual({ changed: true, level: 'text_hash' });
  });
});
