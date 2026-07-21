import { describe, expect, it } from 'vitest';
import { extractHtmlTitle } from '../../src/normalize/extractTitle';

describe('extractHtmlTitle', () => {
  it('extracts the title text from a normal document', async () => {
    const html = '<html><head><title>Example Page</title></head><body><p>Hi</p></body></html>';
    expect(await extractHtmlTitle(html)).toBe('Example Page');
  });

  it('collapses whitespace/newlines to a single space and trims', async () => {
    const html = '<html><head><title>  Example\n  Page\t Title  </title></head></html>';
    expect(await extractHtmlTitle(html)).toBe('Example Page Title');
  });

  it('returns null when there is no title element', async () => {
    const html = '<html><head></head><body><p>Hi</p></body></html>';
    expect(await extractHtmlTitle(html)).toBeNull();
  });

  it('returns null when the title element is empty (whitespace only)', async () => {
    const html = '<html><head><title>   </title></head></html>';
    expect(await extractHtmlTitle(html)).toBeNull();
  });

  it('truncates a title longer than 512 chars', async () => {
    const longTitle = 'x'.repeat(600);
    const html = `<html><head><title>${longTitle}</title></head></html>`;
    const result = await extractHtmlTitle(html);
    expect(result).not.toBeNull();
    expect(result?.length).toBe(512);
    expect(result).toBe('x'.repeat(512));
  });

  it('uses only the first title element when multiple are present', async () => {
    const html = '<html><head><title>First Title</title><title>Second Title</title></head></html>';
    expect(await extractHtmlTitle(html)).toBe('First Title');
  });

  it('drops a trailing surrogate pair whole instead of splitting it at the 512-char boundary', async () => {
    // 511 'x' + 1 emoji (surrogate pair, 2 UTF-16 code units) = 513 code units total.
    // A naive slice(0, 512) would land exactly on the emoji's high surrogate half.
    const longTitle = `${'x'.repeat(511)}😀`;
    const html = `<html><head><title>${longTitle}</title></head></html>`;
    const result = await extractHtmlTitle(html);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(512);
    const lastCode = result!.charCodeAt(result!.length - 1);
    expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true); // no dangling high surrogate
    expect(result).toBe('x'.repeat(511)); // the whole emoji was dropped, not split
  });
});
