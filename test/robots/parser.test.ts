import { describe, expect, it } from 'vitest';
import { normalizePercentEncoding, parseRobotsTxt } from '../../src/robots/parser';

describe('parseRobotsTxt', () => {
  it('groups consecutive user-agent lines into a single group', () => {
    const rules = parseRobotsTxt(
      ['User-agent: a', 'User-agent: b', 'Disallow: /x', '', 'User-agent: c', 'Disallow: /y'].join('\n'),
    );
    expect(rules.groups).toHaveLength(2);
    expect(rules.groups[0]?.userAgents).toEqual(['a', 'b']);
    expect(rules.groups[0]?.rules).toEqual([{ directive: 'disallow', pattern: '/x' }]);
    expect(rules.groups[1]?.userAgents).toEqual(['c']);
  });

  it('starts a new group when user-agent reappears after a rule line', () => {
    const rules = parseRobotsTxt(['User-agent: a', 'Disallow: /x', 'User-agent: a', 'Disallow: /y'].join('\n'));
    expect(rules.groups).toHaveLength(2);
    expect(rules.groups[0]?.rules).toEqual([{ directive: 'disallow', pattern: '/x' }]);
    expect(rules.groups[1]?.rules).toEqual([{ directive: 'disallow', pattern: '/y' }]);
  });

  it('lowercases user-agent tokens but preserves path case', () => {
    const rules = parseRobotsTxt(['User-Agent: UtsuroiBot', 'Disallow: /Private'].join('\n'));
    expect(rules.groups[0]?.userAgents).toEqual(['utsuroibot']);
    expect(rules.groups[0]?.rules[0]?.pattern).toBe('/Private');
  });

  it('ignores comments and blank lines', () => {
    const rules = parseRobotsTxt(
      ['# a comment', '', 'User-agent: *  # trailing comment', 'Disallow: /a # another comment'].join('\n'),
    );
    expect(rules.groups[0]?.userAgents).toEqual(['*']);
    expect(rules.groups[0]?.rules).toEqual([{ directive: 'disallow', pattern: '/a' }]);
  });

  it('treats an empty Disallow value as "allow everything" (no rule emitted)', () => {
    const rules = parseRobotsTxt(['User-agent: *', 'Disallow:'].join('\n'));
    expect(rules.groups[0]?.rules).toEqual([]);
  });

  it('ignores rule lines that appear before any user-agent line', () => {
    const rules = parseRobotsTxt(['Disallow: /x', 'User-agent: *', 'Disallow: /y'].join('\n'));
    expect(rules.groups).toHaveLength(1);
    expect(rules.groups[0]?.rules).toEqual([{ directive: 'disallow', pattern: '/y' }]);
  });

  it('ignores invalid path values not starting with / or *', () => {
    const rules = parseRobotsTxt(['User-agent: *', 'Disallow: private', 'Allow: /ok'].join('\n'));
    expect(rules.groups[0]?.rules).toEqual([{ directive: 'allow', pattern: '/ok' }]);
  });

  it('collects sitemap directives without treating them as blanket allow', () => {
    const rules = parseRobotsTxt(
      ['User-agent: *', 'Disallow: /', 'Sitemap: https://example.com/sitemap.xml'].join('\n'),
    );
    expect(rules.sitemaps).toEqual(['https://example.com/sitemap.xml']);
    expect(rules.groups[0]?.rules).toEqual([{ directive: 'disallow', pattern: '/' }]);
  });

  it('normalizes percent-encoding: decodes unreserved, uppercases reserved hex', () => {
    const rules = parseRobotsTxt(['User-agent: *', 'Disallow: /%7euser/%2f'].join('\n'));
    // %7e (~) is unreserved -> decoded; %2f (/) is reserved -> kept, hex uppercased
    expect(rules.groups[0]?.rules[0]?.pattern).toBe('/~user/%2F');
  });

  it('ignores unknown directives without breaking group boundaries', () => {
    const rules = parseRobotsTxt(
      ['User-agent: *', 'Crawl-delay: 10', 'Disallow: /a', 'Host: example.com'].join('\n'),
    );
    expect(rules.groups).toHaveLength(1);
    expect(rules.groups[0]?.rules).toEqual([{ directive: 'disallow', pattern: '/a' }]);
  });

  it('merges two user-agent lines separated by an unknown directive into a single group (RFC 9309)', () => {
    const rules = parseRobotsTxt(
      ['User-agent: a', 'Crawl-delay: 5', 'User-agent: b', 'Disallow: /'].join('\n'),
    );
    expect(rules.groups).toHaveLength(1);
    expect(rules.groups[0]?.userAgents).toEqual(['a', 'b']);
    expect(rules.groups[0]?.rules).toEqual([{ directive: 'disallow', pattern: '/' }]);
  });

  it('merges two user-agent lines separated by a Host directive into a single group', () => {
    const rules = parseRobotsTxt(
      ['User-agent: a', 'Host: example.com', 'User-agent: b', 'Disallow: /'].join('\n'),
    );
    expect(rules.groups).toHaveLength(1);
    expect(rules.groups[0]?.userAgents).toEqual(['a', 'b']);
    expect(rules.groups[0]?.rules).toEqual([{ directive: 'disallow', pattern: '/' }]);
  });
});

describe('normalizePercentEncoding: non-BMP (astral) characters', () => {
  it('percent-encodes a full astral code point as one 4-byte UTF-8 sequence, not split surrogate halves', () => {
    // U+1F600 (grinning face emoji) is a surrogate pair in UTF-16. Iterating by UTF-16
    // code unit (instead of by code point) would encode each lone surrogate separately,
    // producing two U+FFFD replacement characters instead of the correct 4-byte sequence.
    const astral = '\u{1F600}';
    const expectedBytes = Array.from(new TextEncoder().encode(astral))
      .map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`)
      .join('');
    expect(normalizePercentEncoding(astral)).toBe(expectedBytes);
    // Sanity: a lone surrogate encodes to the UTF-8 replacement character (0xEF 0xBF 0xBD),
    // which is NOT what we expect here -- this pins down that the fix actually matters.
    expect(normalizePercentEncoding(astral)).not.toBe('%EF%BF%BD%EF%BF%BD');
  });

  it('still percent-encodes ordinary BMP non-ASCII characters correctly', () => {
    const result = normalizePercentEncoding('café');
    expect(result).toBe('caf%C3%A9');
  });
});
