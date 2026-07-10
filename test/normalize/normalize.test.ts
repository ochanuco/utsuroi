import { describe, expect, it } from 'vitest';
import { normalizeHtml } from '../../src/normalize';
import { sortAttributeNames } from '../../src/normalize/attributes';

function toBytes(html: string): Uint8Array {
  return new TextEncoder().encode(html);
}

const baseUrl = 'https://example.com/page';

describe('normalizeHtml', () => {
  it('removes script and style elements by default', async () => {
    const html = `<html><head><style>body{color:red}</style></head>
      <body><script>alert(1)</script><p>Hello</p></body></html>`;
    const result = await normalizeHtml(toBytes(html), { baseUrl });
    expect(result.normalizedHtml).not.toContain('<script');
    expect(result.normalizedHtml).not.toContain('<style');
    expect(result.normalizedHtml).toContain('<p>Hello</p>');
  });

  it('keeps script/style when explicitly disabled', async () => {
    const html = `<html><body><script>alert(1)</script><style>a{color:red}</style><p>Hi</p></body></html>`;
    const result = await normalizeHtml(toBytes(html), {
      baseUrl,
      stripScripts: false,
      stripStyles: false,
    });
    expect(result.normalizedHtml).toContain('<script');
    expect(result.normalizedHtml).toContain('<style');
  });

  it('removes comments by default', async () => {
    const html = `<html><body><!-- secret note --><p>Hi</p></body></html>`;
    const result = await normalizeHtml(toBytes(html), { baseUrl });
    expect(result.normalizedHtml).not.toContain('secret note');
  });

  it('removes elements matched by ignoreSelectors', async () => {
    const html = `<html><body><div id="ads">buy now</div><p class="content">Hello</p></body></html>`;
    const result = await normalizeHtml(toBytes(html), {
      baseUrl,
      ignoreSelectors: ['#ads'],
    });
    expect(result.normalizedHtml).not.toContain('buy now');
    expect(result.normalizedHtml).toContain('Hello');
  });

  it('extracts only content under includeSelectors', async () => {
    const html = `<html><body><nav>menu</nav><main><p>Article body</p></main><footer>footer text</footer></body></html>`;
    const result = await normalizeHtml(toBytes(html), {
      baseUrl,
      includeSelectors: ['main'],
    });
    expect(result.normalizedHtml).toContain('Article body');
    expect(result.normalizedHtml).not.toContain('menu');
    expect(result.normalizedHtml).not.toContain('footer text');
    expect(result.extractedText).toContain('Article body');
    expect(result.extractedText).not.toContain('menu');
  });

  it('resolves href/src to absolute URLs based on baseUrl', async () => {
    const html = `<html><body><a href="/about">About</a><img src="images/pic.png"></body></html>`;
    const result = await normalizeHtml(toBytes(html), { baseUrl });
    expect(result.normalizedHtml).toContain('href="https://example.com/about"');
    expect(result.normalizedHtml).toContain('src="https://example.com/images/pic.png"');
  });

  it('strips default tracking query params from URLs', async () => {
    const html = `<html><body><a href="https://example.com/x?utm_source=foo&amp;gclid=abc&amp;keep=1">link</a></body></html>`;
    const result = await normalizeHtml(toBytes(html), { baseUrl });
    expect(result.normalizedHtml).not.toContain('utm_source');
    expect(result.normalizedHtml).not.toContain('gclid');
    expect(result.normalizedHtml).toContain('keep=1');
  });

  it('supports overriding stripQueryParams', async () => {
    const html = `<html><body><a href="https://example.com/x?keep_me=1&amp;drop_me=2">link</a></body></html>`;
    const result = await normalizeHtml(toBytes(html), {
      baseUrl,
      stripQueryParams: ['drop_me'],
    });
    expect(result.normalizedHtml).toContain('keep_me=1');
    expect(result.normalizedHtml).not.toContain('drop_me');
  });

  it('normalizes attribute order alphabetically', async () => {
    const html = `<html><body><div data-z="1" data-a="2" id="x" class="y"></div></body></html>`;
    const result = await normalizeHtml(toBytes(html), { baseUrl });
    const divMatch = result.normalizedHtml.match(/<div[^>]*>/);
    expect(divMatch).not.toBeNull();
    const divTag = divMatch![0];
    const classIdx = divTag.indexOf('class=');
    const dataAIdx = divTag.indexOf('data-a=');
    const dataZIdx = divTag.indexOf('data-z=');
    const idIdx = divTag.indexOf('id=');
    expect(classIdx).toBeGreaterThan(-1);
    expect(dataAIdx).toBeGreaterThan(-1);
    expect(dataZIdx).toBeGreaterThan(-1);
    expect(idIdx).toBeGreaterThan(-1);
    // alphabetical: class < data-a < data-z < id
    expect(classIdx).toBeLessThan(dataAIdx);
    expect(dataAIdx).toBeLessThan(dataZIdx);
    expect(dataZIdx).toBeLessThan(idIdx);
  });

  it('does not change normalizedHash when only a nonce attribute changes', async () => {
    const htmlA = `<html><body><script nonce="AAAA111">void 0</script><p>Same content</p></body></html>`;
    const htmlB = `<html><body><script nonce="ZZZZ999">void 0</script><p>Same content</p></body></html>`;
    // stripScripts: false so the <script> element (and its nonce attribute) is actually
    // present in the normalized tree, rather than being removed before normalization
    // even considers it -- otherwise this test wouldn't exercise nonce stripping at all.
    const resultA = await normalizeHtml(toBytes(htmlA), { baseUrl, stripScripts: false });
    const resultB = await normalizeHtml(toBytes(htmlB), { baseUrl, stripScripts: false });
    expect(resultA.rawHash).not.toBe(resultB.rawHash);
    expect(resultA.normalizedHtml).toContain('<script');
    expect(resultA.normalizedHtml).not.toContain('nonce=');
    expect(resultA.normalizedHash).toBe(resultB.normalizedHash);
  });

  it('removes custom dynamic attributes when overridden, without applying default patterns', async () => {
    const html = `<html><body><div data-csrf-token="abc" data-custom="keepme">x</div></body></html>`;
    const result = await normalizeHtml(toBytes(html), {
      baseUrl,
      dynamicAttributes: ['data-custom'],
    });
    // override 指定時は完全一致のみ判定するため、csrf 系パターンは適用されず残る。
    expect(result.normalizedHtml).toContain('data-csrf-token');
    expect(result.normalizedHtml).not.toContain('data-custom');
  });

  it('removes default dynamic attributes (nonce, csrf-like, timestamp-like) when omitted', async () => {
    const html = `<html><body><div nonce="n1" data-csrf-token="c1" data-timestamp="t1" data-keep="k1">x</div></body></html>`;
    const result = await normalizeHtml(toBytes(html), { baseUrl });
    expect(result.normalizedHtml).not.toContain('nonce=');
    expect(result.normalizedHtml).not.toContain('data-csrf-token');
    expect(result.normalizedHtml).not.toContain('data-timestamp');
    expect(result.normalizedHtml).toContain('data-keep');
  });

  it('sorts by Unicode code point rather than UTF-16 code unit for astral characters', () => {
    // U+F8FF (BMP, private-use area) is a single UTF-16 code unit (0xF8FF).
    const bmpChar = '\u{F8FF}';
    // U+10000 (astral / supplementary plane) is a surrogate pair whose first
    // code unit is 0xD800 -- lower than 0xF8FF despite the code point itself
    // (0x10000) being higher.
    const astralChar = '\u{10000}';

    // Sanity check: naive UTF-16 code-unit `<` comparison disagrees with true
    // Unicode code point order for this pair (proves the bug would matter).
    expect(astralChar < bmpChar).toBe(true);

    // True code point order: U+F8FF (63743) < U+10000 (65536).
    expect(sortAttributeNames([astralChar, bmpChar])).toEqual([bmpChar, astralChar]);
  });

  it('extracts plain text with newlines at block element boundaries', async () => {
    const html = `<html><body><h1>Title</h1><p>Paragraph one.</p><p>Paragraph two.</p></body></html>`;
    const result = await normalizeHtml(toBytes(html), { baseUrl });
    const lines = result.extractedText.split('\n');
    expect(lines).toEqual(['Title', 'Paragraph one.', 'Paragraph two.']);
  });

  it('collapses consecutive whitespace in extractedText', async () => {
    const html = `<html><body><p>Hello    \n\n   world</p></body></html>`;
    const result = await normalizeHtml(toBytes(html), { baseUrl });
    expect(result.extractedText).toBe('Hello world');
  });

  it('produces stable hashes and version metadata', async () => {
    const html = `<html><body><p>content</p></body></html>`;
    const result = await normalizeHtml(toBytes(html), { baseUrl });
    expect(result.rawHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.normalizedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.textHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.normalizationVersion).toBe(1);
  });

  it('decodes non-UTF-8 bytes declared via meta charset (best effort)', async () => {
    // Shift_JIS encoded 'こんにちは' inside a declared meta charset document.
    const text = 'こんにちは';
    const sjisBytes = encodeShiftJisBestEffort(text);
    const htmlHead = `<html><head><meta charset="Shift_JIS"></head><body><p>`;
    const htmlTail = `</p></body></html>`;
    const full = new Uint8Array([
      ...new TextEncoder().encode(htmlHead),
      ...sjisBytes,
      ...new TextEncoder().encode(htmlTail),
    ]);
    const result = await normalizeHtml(full, { baseUrl });
    expect(result.extractedText).toBe(text);
  });
});

// Minimal Shift_JIS encoder for a handful of common hiragana characters,
// sufficient to exercise the charset-sniffing best-effort path in tests
// without adding a dependency. Falls back to UTF-8 bytes if a character
// is not in the small lookup table (keeps the test self-contained).
function encodeShiftJisBestEffort(text: string): Uint8Array {
  const table: Record<string, [number, number]> = {
    こ: [0x82, 0xb1],
    ん: [0x82, 0xf1],
    に: [0x82, 0xc9],
    ち: [0x82, 0xbf],
    は: [0x82, 0xcd],
  };
  const bytes: number[] = [];
  for (const ch of text) {
    const pair = table[ch];
    if (!pair) throw new Error(`no shift_jis mapping for ${ch} in test helper`);
    bytes.push(pair[0], pair[1]);
  }
  return new Uint8Array(bytes);
}
