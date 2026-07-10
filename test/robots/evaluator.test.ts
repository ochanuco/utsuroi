import { describe, expect, it } from 'vitest';
import { parseRobotsTxt } from '../../src/robots/parser';
import { evaluateRobots } from '../../src/robots/evaluator';

const UA = 'utsuroibot';

describe('evaluateRobots', () => {
  it('allows by default when no group matches', () => {
    const rules = parseRobotsTxt(['User-agent: othercrawler', 'Disallow: /'].join('\n'));
    const result = evaluateRobots(rules, 'https://example.com/anything', UA);
    expect(result.verdict).toBe('allowed');
    expect(result.userAgentGroup).toBe('none');
    expect(result.matchedRule).toBeNull();
  });

  it('prefers the utsuroibot-specific group over the wildcard group', () => {
    const rules = parseRobotsTxt(
      ['User-agent: *', 'Disallow: /', '', 'User-agent: UtsuroiBot', 'Allow: /'].join('\n'),
    );
    const result = evaluateRobots(rules, 'https://example.com/page', UA);
    expect(result.verdict).toBe('allowed');
    expect(result.userAgentGroup).toBe('utsuroibot');
    expect(result.matchedRule).toBe('allow: /');
  });

  it('falls back to the wildcard group when no specific group exists', () => {
    const rules = parseRobotsTxt(['User-agent: *', 'Disallow: /private'].join('\n'));
    const allowedResult = evaluateRobots(rules, 'https://example.com/public', UA);
    expect(allowedResult.verdict).toBe('allowed');
    expect(allowedResult.userAgentGroup).toBe('*');

    const blockedResult = evaluateRobots(rules, 'https://example.com/private/x', UA);
    expect(blockedResult.verdict).toBe('disallowed');
    expect(blockedResult.matchedRule).toBe('disallow: /private');
  });

  it('applies longest-match precedence', () => {
    const rules = parseRobotsTxt(['User-agent: *', 'Disallow: /a', 'Allow: /a/b'].join('\n'));
    expect(evaluateRobots(rules, 'https://example.com/a/x', UA).verdict).toBe('disallowed');
    expect(evaluateRobots(rules, 'https://example.com/a/b/x', UA).verdict).toBe('allowed');
  });

  it('prefers allow over disallow when pattern lengths tie', () => {
    const rules = parseRobotsTxt(['User-agent: *', 'Disallow: /page', 'Allow: /page'].join('\n'));
    const result = evaluateRobots(rules, 'https://example.com/page', UA);
    expect(result.verdict).toBe('allowed');
    expect(result.matchedRule).toBe('allow: /page');
  });

  it('supports "*" mid-pattern wildcards', () => {
    const rules = parseRobotsTxt(['User-agent: *', 'Disallow: /*.pdf'].join('\n'));
    expect(evaluateRobots(rules, 'https://example.com/docs/report.pdf', UA).verdict).toBe('disallowed');
    expect(evaluateRobots(rules, 'https://example.com/docs/report.pdf.html', UA).verdict).toBe('disallowed');
    expect(evaluateRobots(rules, 'https://example.com/docs/report.txt', UA).verdict).toBe('allowed');
  });

  it('supports "$" end-of-path anchoring', () => {
    const rules = parseRobotsTxt(['User-agent: *', 'Disallow: /*.pdf$'].join('\n'));
    expect(evaluateRobots(rules, 'https://example.com/docs/report.pdf', UA).verdict).toBe('disallowed');
    expect(evaluateRobots(rules, 'https://example.com/docs/report.pdf.html', UA).verdict).toBe('allowed');
  });

  it('is case-insensitive for the user-agent token but case-sensitive for paths', () => {
    const rules = parseRobotsTxt(['User-agent: UTSUROIBOT', 'Disallow: /Secret'].join('\n'));
    expect(evaluateRobots(rules, 'https://example.com/Secret', UA).verdict).toBe('disallowed');
    expect(evaluateRobots(rules, 'https://example.com/secret', UA).verdict).toBe('allowed');
  });

  it('matches query strings as part of the path', () => {
    const rules = parseRobotsTxt(['User-agent: *', 'Disallow: /search?q='].join('\n'));
    expect(evaluateRobots(rules, 'https://example.com/search?q=foo', UA).verdict).toBe('disallowed');
    expect(evaluateRobots(rules, 'https://example.com/search', UA).verdict).toBe('allowed');
  });

  it('does not treat a Sitemap directive as blanket allow (ADR-0008)', () => {
    const rules = parseRobotsTxt(
      ['User-agent: *', 'Disallow: /', 'Sitemap: https://example.com/sitemap.xml'].join('\n'),
    );
    const result = evaluateRobots(rules, 'https://example.com/anything', UA);
    expect(result.verdict).toBe('disallowed');
  });
});
