import { describe, expect, it } from 'vitest';
import { decodeHtmlBestEffort } from '../../src/normalize/charset';

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
