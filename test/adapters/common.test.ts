import { describe, expect, it } from 'vitest';
import { AdapterParseError, detectFeedType, parseSource } from '../../src/adapters';

const enc = (s: string) => new TextEncoder().encode(s);
const BASE = { baseUrl: 'https://example.com/' };

describe('detectFeedType', () => {
  it('detects rss root', () => {
    const xml = `<rss version="2.0"><channel><title>F</title></channel></rss>`;
    expect(detectFeedType(enc(xml))).toBe('rss');
  });

  it('detects atom root', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title></feed>`;
    expect(detectFeedType(enc(xml))).toBe('atom');
  });

  it('returns null for unrelated root elements', () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a</loc></url></urlset>`;
    expect(detectFeedType(enc(xml))).toBeNull();
  });

  it('returns null (does not throw) for malformed XML', () => {
    const xml = `<rss version="2.0"><channel><title>Broken</channel></rss>`;
    expect(detectFeedType(enc(xml))).toBeNull();
  });
});

describe('parseSource unsupported sourceType', () => {
  it('throws AdapterParseError(unsupported_source_type) for sourceType=page', () => {
    // Use toThrow() to assert the call actually throws (rather than a try/catch where a
    // failed expect.unreachable() would itself be swallowed by the same catch block,
    // masking a bug where parseSource silently didn't throw).
    expect(() => parseSource('page', enc('<html></html>'), BASE)).toThrow(AdapterParseError);

    let caught: unknown;
    try {
      parseSource('page', enc('<html></html>'), BASE);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterParseError);
    expect((caught as AdapterParseError).code).toBe('unsupported_source_type');
    expect((caught as AdapterParseError).failureClass).toBe('parse_error');
  });
});
