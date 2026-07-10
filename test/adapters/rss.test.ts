import { describe, expect, it } from 'vitest';
import { AdapterParseError, parseRss, parseSource } from '../../src/adapters';

const enc = (s: string) => new TextEncoder().encode(s);

const BASE = { baseUrl: 'https://example.com/' };

describe('parseRss', () => {
  it('parses a standard RSS 2.0 feed with guid, order preserved', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <item>
      <title>First Post</title>
      <link>https://example.com/1</link>
      <guid>urn:uuid:abc-1</guid>
      <pubDate>Wed, 02 Oct 2002 08:00:00 EST</pubDate>
      <description>first body</description>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://example.com/2</link>
      <guid>urn:uuid:abc-2</guid>
      <pubDate>Thu, 03 Oct 2002 08:00:00 +0900</pubDate>
      <description>second body</description>
    </item>
  </channel>
</rss>`;
    const result = parseRss(enc(xml), BASE);
    expect(result.kind).toBe('rss');
    expect(result.meta.title).toBe('Example Feed');
    expect(result.items).toHaveLength(2);
    expect(result.items[0].stableKey).toBe('urn:uuid:abc-1');
    expect(result.items[0].url).toBe('https://example.com/1');
    expect(result.items[0].title).toBe('First Post');
    // EST (UTC-5) 08:00 -> 13:00Z
    expect(result.items[0].publishedAt).toBe('2002-10-02T13:00:00.000Z');
    expect(result.items[1].stableKey).toBe('urn:uuid:abc-2');
    // +0900 08:00 -> previous day 23:00Z
    expect(result.items[1].publishedAt).toBe('2002-10-02T23:00:00.000Z');
    // document order preserved
    expect(result.items.map((i) => i.title)).toEqual(['First Post', 'Second Post']);
    expect(result.childSitemaps).toEqual([]);
  });

  it('falls back to link when guid is missing', () => {
    const xml = `<rss version="2.0"><channel><title>F</title>
      <item><title>No Guid</title><link>https://example.com/no-guid</link><pubDate>Wed, 02 Oct 2002 08:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const result = parseRss(enc(xml), BASE);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].stableKey).toBe('https://example.com/no-guid');
  });

  it('falls back to a title+pubDate hash when guid and link are both missing', () => {
    const xml = `<rss version="2.0"><channel><title>F</title>
      <item><title>Only Title</title><pubDate>Wed, 02 Oct 2002 08:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const result = parseRss(enc(xml), BASE);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].url).toBeNull();
    expect(result.items[0].stableKey).toMatch(/^[0-9a-f]{8}$/);

    // deterministic: same title+pubDate -> same key
    const again = parseRss(enc(xml), BASE);
    expect(again.items[0].stableKey).toBe(result.items[0].stableKey);
  });

  it('handles CDATA content and namespaced sibling elements without breaking core fields', () => {
    const xml = `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
      <channel><title>F</title>
        <item>
          <title><![CDATA[Cool & <Fun> Title]]></title>
          <link>https://example.com/cdata</link>
          <guid>cdata-guid</guid>
          <media:content url="https://example.com/img.png" />
          <description><![CDATA[<p>body</p>]]></description>
        </item>
      </channel>
    </rss>`;
    const result = parseRss(enc(xml), BASE);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('Cool & <Fun> Title');
    expect(result.items[0].summary).toBe('<p>body</p>');
    expect(result.items[0].stableKey).toBe('cdata-guid');
  });

  it('dedupes items sharing the same stableKey, keeping the first occurrence', () => {
    const xml = `<rss version="2.0"><channel><title>F</title>
      <item><title>Original</title><guid>dup-1</guid></item>
      <item><title>Duplicate</title><guid>dup-1</guid></item>
      <item><title>Unique</title><guid>dup-2</guid></item>
    </channel></rss>`;
    const result = parseRss(enc(xml), BASE);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].title).toBe('Original');
    expect(result.items[1].title).toBe('Unique');
  });

  it('throws AdapterParseError(unexpected_root) for a non-rss root', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Not RSS</title></feed>`;
    expect(() => parseRss(enc(xml), BASE)).toThrow(AdapterParseError);
    try {
      parseRss(enc(xml), BASE);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterParseError);
      expect((err as AdapterParseError).code).toBe('unexpected_root');
      expect((err as AdapterParseError).failureClass).toBe('parse_error');
    }
  });

  it('throws AdapterParseError(invalid_xml) for malformed XML', () => {
    const xml = `<rss version="2.0"><channel><title>Broken</channel></rss>`;
    try {
      parseRss(enc(xml), BASE);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterParseError);
      expect((err as AdapterParseError).code).toBe('invalid_xml');
    }
  });

  it('decodes non-UTF-8 bodies declared via the XML encoding declaration', () => {
    // ISO-8859-1: 'é' (U+00E9) is a single byte 0xE9, matching charCodeAt directly.
    const xml = `<?xml version="1.0" encoding="ISO-8859-1"?><rss version="2.0"><channel><title>Café Feed</title><item><title>Café Post</title><guid>g1</guid></item></channel></rss>`;
    const bytes = new Uint8Array(xml.length);
    for (let i = 0; i < xml.length; i++) bytes[i] = xml.charCodeAt(i) & 0xff;

    const result = parseRss(bytes, BASE);
    expect(result.meta.title).toBe('Café Feed');
    expect(result.items[0].title).toBe('Café Post');
  });

  it('is reachable via parseSource', () => {
    const xml = `<rss version="2.0"><channel><title>F</title><item><guid>g</guid></item></channel></rss>`;
    const result = parseSource('rss', enc(xml), BASE);
    expect(result.kind).toBe('rss');
    expect(result.items).toHaveLength(1);
  });
});
