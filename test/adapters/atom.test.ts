import { describe, expect, it } from 'vitest';
import { AdapterParseError, parseAtom, parseSource } from '../../src/adapters';

const enc = (s: string) => new TextEncoder().encode(s);
const BASE = { baseUrl: 'https://example.com/' };

describe('parseAtom', () => {
  it('parses a standard Atom feed, preferring id and rel=alternate link', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom</title>
  <entry>
    <title>Entry One</title>
    <id>urn:uuid:e1</id>
    <link rel="self" href="https://example.com/feed.xml" />
    <link rel="alternate" href="https://example.com/e1" />
    <updated>2024-01-02T03:04:05Z</updated>
    <published>2024-01-01T00:00:00Z</published>
    <summary>summary one</summary>
  </entry>
  <entry>
    <title>Entry Two</title>
    <id>urn:uuid:e2</id>
    <link rel="alternate" href="https://example.com/e2" />
    <updated>2024-02-02T03:04:05+09:00</updated>
  </entry>
</feed>`;
    const result = parseAtom(enc(xml), BASE);
    expect(result.kind).toBe('atom');
    expect(result.meta.title).toBe('Example Atom');
    expect(result.items).toHaveLength(2);

    expect(result.items[0].stableKey).toBe('urn:uuid:e1');
    expect(result.items[0].url).toBe('https://example.com/e1');
    expect(result.items[0].updatedAt).toBe('2024-01-02T03:04:05.000Z');
    expect(result.items[0].publishedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(result.items[0].summary).toBe('summary one');

    expect(result.items[1].stableKey).toBe('urn:uuid:e2');
    // +09:00 -> UTC
    expect(result.items[1].updatedAt).toBe('2024-02-01T18:04:05.000Z');

    // document order preserved
    expect(result.items.map((i) => i.title)).toEqual(['Entry One', 'Entry Two']);
  });

  it('handles a single entry (not wrapped in an array in the source XML)', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <title>Solo</title>
      <entry>
        <title>Only One</title>
        <id>only-1</id>
        <link href="https://example.com/only" />
      </entry>
    </feed>`;
    const result = parseAtom(enc(xml), BASE);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].stableKey).toBe('only-1');
    expect(result.items[0].url).toBe('https://example.com/only');
  });

  it('falls back to link when id is missing, and to title+date hash when both are missing', () => {
    const xmlLinkOnly = `<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>
      <entry><title>No Id</title><link rel="alternate" href="https://example.com/no-id" /><updated>2024-01-01T00:00:00Z</updated></entry>
    </feed>`;
    const r1 = parseAtom(enc(xmlLinkOnly), BASE);
    expect(r1.items[0].stableKey).toBe('https://example.com/no-id');

    const xmlNoKeys = `<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>
      <entry><title>No Keys At All</title><updated>2024-01-01T00:00:00Z</updated></entry>
    </feed>`;
    const r2 = parseAtom(enc(xmlNoKeys), BASE);
    expect(r2.items[0].url).toBeNull();
    expect(r2.items[0].stableKey).toMatch(/^[0-9a-f]{8}$/);
  });

  it('handles CDATA in title/summary', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>
      <entry>
        <title><![CDATA[A & B]]></title>
        <id>cdata-1</id>
        <summary><![CDATA[<p>hi</p>]]></summary>
      </entry>
    </feed>`;
    const result = parseAtom(enc(xml), BASE);
    expect(result.items[0].title).toBe('A & B');
    expect(result.items[0].summary).toBe('<p>hi</p>');
  });

  it('dedupes entries sharing the same stableKey, keeping the first occurrence', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>
      <entry><title>First</title><id>dup</id></entry>
      <entry><title>Second</title><id>dup</id></entry>
    </feed>`;
    const result = parseAtom(enc(xml), BASE);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('First');
  });

  it('throws AdapterParseError(unexpected_root) for a non-atom root', () => {
    const xml = `<rss version="2.0"><channel><title>Not Atom</title></channel></rss>`;
    try {
      parseAtom(enc(xml), BASE);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterParseError);
      expect((err as AdapterParseError).code).toBe('unexpected_root');
    }
  });

  it('throws AdapterParseError(invalid_xml) for malformed XML', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>oops</entry></feed>`;
    try {
      parseAtom(enc(xml), BASE);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterParseError);
      expect((err as AdapterParseError).code).toBe('invalid_xml');
    }
  });

  it('is reachable via parseSource', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title><entry><id>g</id></entry></feed>`;
    const result = parseSource('atom', enc(xml), BASE);
    expect(result.kind).toBe('atom');
    expect(result.items).toHaveLength(1);
  });
});
