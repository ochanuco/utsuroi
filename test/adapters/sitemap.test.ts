import { describe, expect, it } from 'vitest';
import {
  AdapterParseError,
  parseSitemap,
  parseSitemapIndex,
  parseSource,
} from '../../src/adapters';

const enc = (s: string) => new TextEncoder().encode(s);
const BASE = { baseUrl: 'https://example.com/base/' };

describe('parseSitemap', () => {
  it('parses urlset, resolving relative loc against baseUrl and normalizing lastmod', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>  /page-1  </loc><lastmod>2024-01-01</lastmod></url>
  <url><loc>https://other.example.com/page-2</loc><lastmod>2024-02-02T10:00:00Z</lastmod></url>
</urlset>`;
    const result = parseSitemap(enc(xml), BASE);
    expect(result.kind).toBe('sitemap');
    expect(result.childSitemaps).toEqual([]);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.stableKey).toBe('https://example.com/page-1');
    expect(result.items[0]!.url).toBe('https://example.com/page-1');
    expect(result.items[0]!.updatedAt).toBe(new Date('2024-01-01').toISOString());
    expect(result.items[1]!.stableKey).toBe('https://other.example.com/page-2');
    expect(result.items[1]!.updatedAt).toBe('2024-02-02T10:00:00.000Z');
    // document order preserved
    expect(result.items.map((i) => i.url)).toEqual([
      'https://example.com/page-1',
      'https://other.example.com/page-2',
    ]);
  });

  it('handles a single <url> entry not wrapped in an array', () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/solo</loc></url>
    </urlset>`;
    const result = parseSitemap(enc(xml), BASE);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.stableKey).toBe('https://example.com/solo');
    expect(result.items[0]!.updatedAt).toBeNull();
  });

  it('dedupes urls sharing the same resolved loc, keeping the first occurrence', () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/dup</loc><lastmod>2024-01-01</lastmod></url>
      <url><loc>https://example.com/dup</loc><lastmod>2024-02-02</lastmod></url>
    </urlset>`;
    const result = parseSitemap(enc(xml), BASE);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.updatedAt).toBe(new Date('2024-01-01').toISOString());
  });

  it('throws AdapterParseError(unexpected_root) for a non-urlset root', () => {
    const xml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>`;
    try {
      parseSitemap(enc(xml), BASE);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterParseError);
      expect((err as AdapterParseError).code).toBe('unexpected_root');
    }
  });

  it('throws AdapterParseError(invalid_xml) for malformed XML', () => {
    const xml = `<urlset><url><loc>https://example.com/x</urlset>`;
    try {
      parseSitemap(enc(xml), BASE);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterParseError);
      expect((err as AdapterParseError).code).toBe('invalid_xml');
    }
  });
});

describe('parseSitemapIndex', () => {
  it('parses sitemapindex into childSitemaps, and mirrors the same loc+lastmod into items (ADR-0010 Phase A: Sitemap Direct needs items for both urlset and sitemapindex)', () => {
    const xml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>/sitemap-1.xml</loc><lastmod>2024-01-01</lastmod></sitemap>
      <sitemap><loc>https://other.example.com/sitemap-2.xml</loc></sitemap>
    </sitemapindex>`;
    const result = parseSitemapIndex(enc(xml), BASE);
    expect(result.kind).toBe('sitemap-index');
    expect(result.childSitemaps).toEqual([
      'https://example.com/sitemap-1.xml',
      'https://other.example.com/sitemap-2.xml',
    ]);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.stableKey).toBe('https://example.com/sitemap-1.xml');
    expect(result.items[0]!.url).toBe('https://example.com/sitemap-1.xml');
    expect(result.items[0]!.updatedAt).toBe(new Date('2024-01-01').toISOString());
    expect(result.items[1]!.stableKey).toBe('https://other.example.com/sitemap-2.xml');
    expect(result.items[1]!.updatedAt).toBeNull();
  });

  it('dedupes sitemap entries sharing the same resolved loc, keeping the first occurrence for both childSitemaps and items', () => {
    const xml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/dup.xml</loc><lastmod>2024-01-01</lastmod></sitemap>
      <sitemap><loc>https://example.com/dup.xml</loc><lastmod>2024-02-02</lastmod></sitemap>
    </sitemapindex>`;
    const result = parseSitemapIndex(enc(xml), BASE);
    expect(result.childSitemaps).toEqual(['https://example.com/dup.xml']);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.updatedAt).toBe(new Date('2024-01-01').toISOString());
  });

  it('throws AdapterParseError(unexpected_root) for a non-sitemapindex root', () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/x</loc></url></urlset>`;
    try {
      parseSitemapIndex(enc(xml), BASE);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterParseError);
      expect((err as AdapterParseError).code).toBe('unexpected_root');
    }
  });
});

describe('parseSource sitemap auto-detection', () => {
  it('sourceType=sitemap with a sitemapindex body returns kind=sitemap-index with childSitemaps filled', () => {
    const xml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/child.xml</loc></sitemap>
    </sitemapindex>`;
    const result = parseSource('sitemap', enc(xml), BASE);
    expect(result.kind).toBe('sitemap-index');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.url).toBe('https://example.com/child.xml');
    expect(result.childSitemaps).toEqual(['https://example.com/child.xml']);
  });

  it('sourceType=sitemap-index with a urlset body returns kind=sitemap with items filled', () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/page</loc></url>
    </urlset>`;
    const result = parseSource('sitemap-index', enc(xml), BASE);
    expect(result.kind).toBe('sitemap');
    expect(result.items).toHaveLength(1);
    expect(result.childSitemaps).toEqual([]);
  });

  it('sourceType=sitemap with a normal urlset body returns kind=sitemap', () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a</loc></url></urlset>`;
    const result = parseSource('sitemap', enc(xml), BASE);
    expect(result.kind).toBe('sitemap');
    expect(result.items).toHaveLength(1);
  });

  it('throws AdapterParseError(unexpected_root) when neither urlset nor sitemapindex', () => {
    const xml = `<rss version="2.0"><channel><title>Not a sitemap</title></channel></rss>`;
    try {
      parseSource('sitemap', enc(xml), BASE);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterParseError);
      expect((err as AdapterParseError).code).toBe('unexpected_root');
    }
  });
});
