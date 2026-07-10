import { describe, expect, it } from 'vitest';
import { decodeHtmlBestEffort, extractCharsetFromContentType } from '../../src/normalize/charset';

/**
 * ASCII の HTML 断片と、Shift_JIS で「あ」を表すバイト列 (0x82 0xA0) を連結した
 * バイト列を作る。UTF-8 として復号すると不正シーケンスとして置換文字
 * (U+FFFD) になるが、Shift_JIS として正しく復号すると「あ」になる。
 * これにより、charset 検出が実際に shift_jis を選んだかどうかを検証できる。
 */
function buildHtmlBytes(metaTag: string): Uint8Array {
  const head = new TextEncoder().encode(
    `<html><head>${metaTag}</head><body>`,
  );
  const shiftJisA = new Uint8Array([0x82, 0xa0]); // Shift_JIS で「あ」
  const tail = new TextEncoder().encode('</body></html>');

  const combined = new Uint8Array(head.length + shiftJisA.length + tail.length);
  combined.set(head, 0);
  combined.set(shiftJisA, head.length);
  combined.set(tail, head.length + shiftJisA.length);
  return combined;
}

describe('decodeHtmlBestEffort / meta http-equiv charset sniffing', () => {
  it('detects charset when content comes BEFORE http-equiv (previously-broken order)', () => {
    const bytes = buildHtmlBytes(
      '<meta content="text/html; charset=shift_jis" http-equiv="Content-Type">',
    );
    const decoded = decodeHtmlBestEffort(bytes);
    expect(decoded).toContain('あ');
    expect(decoded).not.toContain('�');
  });

  it('detects charset when http-equiv comes BEFORE content (forward order regression)', () => {
    const bytes = buildHtmlBytes(
      '<meta http-equiv="Content-Type" content="text/html; charset=shift_jis">',
    );
    const decoded = decodeHtmlBestEffort(bytes);
    expect(decoded).toContain('あ');
    expect(decoded).not.toContain('�');
  });

  it('does not mistake a data-charset custom attribute name for a real charset= declaration', () => {
    // A `data-charset` custom attribute should not be sniffed as a real charset
    // declaration -- only a standalone `charset=` attribute name counts. Since there's no
    // genuine charset declaration here, decoding must fall back to UTF-8 and therefore fail
    // to decode the embedded Shift_JIS bytes correctly (producing the replacement
    // character), proving the bogus attribute name was correctly ignored.
    const bytes = buildHtmlBytes('<meta data-charset="shift_jis">');
    const decoded = decodeHtmlBestEffort(bytes);
    expect(decoded).not.toContain('あ');
    expect(decoded).toContain('�');
  });

  it('does not mistake data-http-equiv/data-content attribute names for the real http-equiv/content attributes', () => {
    // Both attribute *names* here are custom (`data-http-equiv`, `data-content`), and their
    // values do not happen to contain the literal substring "charset=" either, so this
    // isolates the attribute-name boundary fix from the (separate, expected) limitation
    // that the regex-based sniffer cannot distinguish an attribute value from surrounding
    // structure once "charset=" literally appears as text.
    const bytes = buildHtmlBytes(
      '<meta data-http-equiv="Content-Type" data-content="text/html; encoding=shift_jis">',
    );
    const decoded = decodeHtmlBestEffort(bytes);
    expect(decoded).not.toContain('あ');
    expect(decoded).toContain('�');
  });
});

describe('decodeHtmlBestEffort / HTTP header charset priority (WHATWG: BOM > header > meta/XML sniff > UTF-8)', () => {
  it('uses the HTTP header charset when there is no meta charset declaration at all', () => {
    const bytes = buildHtmlBytes('');
    const decoded = decodeHtmlBestEffort(bytes, 'Shift_JIS');
    expect(decoded).toContain('あ');
    expect(decoded).not.toContain('�');
  });

  it('prioritizes the HTTP header charset over a conflicting meta charset declaration', () => {
    // meta claims utf-8 (wrong), but the body bytes are actually Shift_JIS -- the header
    // charset must win per the WHATWG priority order (header beats meta/XML sniff).
    const bytes = buildHtmlBytes('<meta charset="utf-8">');
    const decoded = decodeHtmlBestEffort(bytes, 'Shift_JIS');
    expect(decoded).toContain('あ');
    expect(decoded).not.toContain('�');
  });

  it('falls back to meta/XML sniffing when the header charset label is unsupported by TextDecoder', () => {
    const bytes = buildHtmlBytes('<meta charset="shift_jis">');
    const decoded = decodeHtmlBestEffort(bytes, 'not-a-real-charset-label');
    expect(decoded).toContain('あ');
    expect(decoded).not.toContain('�');
  });
});

describe('extractCharsetFromContentType', () => {
  it('extracts the charset parameter from a Content-Type header value', () => {
    expect(extractCharsetFromContentType('text/html; charset=Shift_JIS')).toBe('Shift_JIS');
    expect(extractCharsetFromContentType('application/rss+xml;charset=UTF-8')).toBe('UTF-8');
    expect(extractCharsetFromContentType('text/html; charset="UTF-8"')).toBe('UTF-8');
  });

  it('returns undefined when there is no charset parameter or no Content-Type at all', () => {
    expect(extractCharsetFromContentType('text/html')).toBeUndefined();
    expect(extractCharsetFromContentType(null)).toBeUndefined();
    expect(extractCharsetFromContentType(undefined)).toBeUndefined();
  });
});
