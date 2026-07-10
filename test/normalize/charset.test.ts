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
});
