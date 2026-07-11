/**
 * extractItems (ADR-0011) の HTMLRewriter (lol-html) 抽出セマンティクスの固定テスト。
 *
 * 前半 ("HTMLRewriter 挙動の固定" describe) は、extractItems の実装が前提とする lol-html の
 * 生の挙動そのものを検証する「スパイクテスト」であり、これらが壊れた場合は extractItems.ts の
 * 設計 (element境界 + 子孫セレクタの相関によるアイテム分割、深さカウンタによる入れ子フラット化)
 * の前提が崩れていることを意味する。後半は extractItems の公開契約
 * (extractItems(body, opts) => Promise<FeedItem[]>) の振る舞いを検証する。
 */
import { describe, expect, it } from 'vitest';
import { extractItems } from '../../src/normalize';

function toBytes(html: string): Uint8Array {
  return new TextEncoder().encode(html);
}

const baseUrl = 'https://example.com/list';

describe('HTMLRewriter (lol-html) 挙動の固定 (extractItems の設計前提)', () => {
  it('on(itemSelector, { element }) + element.onEndTag() でアイテムの開始/終了境界が文書順に取れる', async () => {
    const html = `<ul><li class="item"><a href="/a">A</a></li><li class="item"><a href="/b">B</a></li></ul>`;
    const events: string[] = [];
    const rewriter = new HTMLRewriter().on('.item', {
      element(e) {
        events.push('open');
        e.onEndTag(() => {
          events.push('close');
        });
      },
    });
    await rewriter.transform(new Response(html)).text();
    expect(events).toEqual(['open', 'close', 'open', 'close']);
  });

  it('`${itemSelector} a` の子孫結合子ハンドラは「現在開いているアイテム」内のリンクとして文書順に相関できる', async () => {
    const html = `<ul><li class="item"><a href="/a">A</a></li><li class="item"><a href="/b">B</a></li></ul>`;
    const events: string[] = [];
    const rewriter = new HTMLRewriter()
      .on('.item', {
        element(e) {
          events.push('item-open');
          e.onEndTag(() => {
            events.push('item-close');
          });
        },
      })
      .on('.item a', {
        element(e) {
          events.push(`link:${e.getAttribute('href')}`);
        },
      });
    await rewriter.transform(new Response(html)).text();
    expect(events).toEqual(['item-open', 'link:/a', 'item-close', 'item-open', 'link:/b', 'item-close']);
  });

  it('text ハンドラはマッチ要素の子孫テキストを受け取る (孫要素のテキストも拾う)', async () => {
    const html = `<div class="item"><span>Hello <b>World</b></span></div>`;
    const texts: string[] = [];
    const rewriter = new HTMLRewriter().on('.item', {
      text(t) {
        texts.push(t.text);
      },
    });
    await rewriter.transform(new Response(html)).text();
    const joined = texts.join('');
    expect(joined).toContain('Hello');
    expect(joined).toContain('World');
  });

  it('入れ子アイテム (item内item) は lol-html 側では独立に開始/終了を発火する (自動フラット化はしない)', async () => {
    const html = `<div class="item" id="outer"><div class="item" id="inner"><a href="/x">X</a></div></div>`;
    const events: string[] = [];
    const rewriter = new HTMLRewriter().on('.item', {
      element(e) {
        const id = e.getAttribute('id');
        events.push(`open:${id}`);
        e.onEndTag(() => {
          events.push(`close:${id}`);
        });
      },
    });
    await rewriter.transform(new Response(html)).text();
    expect(events).toEqual(['open:outer', 'open:inner', 'close:inner', 'close:outer']);
  });
});

describe('extractItems: 公開契約 (extractItems(body, opts) => Promise<FeedItem[]>)', () => {
  it('複数アイテムを抽出し、URL・タイトルを対応付ける', async () => {
    const html = `<ul>
      <li class="item"><h2>Title One</h2><a href="/one">read more</a></li>
      <li class="item"><h2>Title Two</h2><a href="/two">read more</a></li>
    </ul>`;
    const items = await extractItems(toBytes(html), {
      itemSelector: '.item',
      titleSelector: 'h2',
      baseUrl,
    });
    expect(items).toEqual([
      {
        stableKey: 'https://example.com/one',
        url: 'https://example.com/one',
        title: 'Title One',
        publishedAt: null,
        updatedAt: null,
        summary: null,
      },
      {
        stableKey: 'https://example.com/two',
        url: 'https://example.com/two',
        title: 'Title Two',
        publishedAt: null,
        updatedAt: null,
        summary: null,
      },
    ]);
  });

  it('リンクの無いアイテムは除外する', async () => {
    const html = `<ul>
      <li class="item"><h2>No Link Here</h2></li>
      <li class="item"><h2>Has Link</h2><a href="/has-link">go</a></li>
    </ul>`;
    const items = await extractItems(toBytes(html), { itemSelector: '.item', titleSelector: 'h2', baseUrl });
    expect(items).toHaveLength(1);
    expect(items[0]!.url).toBe('https://example.com/has-link');
  });

  it('入れ子アイテムは外側優先でフラット化する (内側は独立したアイテムにならない)', async () => {
    const html = `<div class="item" id="outer">
      <a href="/outer-link">outer</a>
      <div class="item" id="inner"><a href="/inner-link">inner</a></div>
    </div>`;
    const items = await extractItems(toBytes(html), { itemSelector: '.item', baseUrl });
    // 外側1件のみ (内側は独立アイテムを作らない)。url は文書順で最初に見つかったリンク (outer-link)。
    expect(items).toHaveLength(1);
    expect(items[0]!.url).toBe('https://example.com/outer-link');
  });

  it('外側にリンクが無く内側にのみリンクがある場合、内側のリンクがそのアイテムのURLとして採用される', async () => {
    const html = `<div class="item" id="outer">
      <div class="item" id="inner"><a href="/inner-only">inner</a></div>
    </div>`;
    const items = await extractItems(toBytes(html), { itemSelector: '.item', baseUrl });
    expect(items).toHaveLength(1);
    expect(items[0]!.url).toBe('https://example.com/inner-only');
  });

  it('相対URLを baseUrl 基準で絶対URL化する', async () => {
    const html = `<div class="item"><a href="/relative/path">go</a></div>`;
    const items = await extractItems(toBytes(html), { itemSelector: '.item', baseUrl: 'https://example.com/list/' });
    expect(items[0]!.url).toBe('https://example.com/relative/path');
  });

  it('titleSelector 省略時はリンクテキストへフォールバックする', async () => {
    const html = `<div class="item"><a href="/x">  Link Text Here  </a></div>`;
    const items = await extractItems(toBytes(html), { itemSelector: '.item', baseUrl });
    expect(items[0]!.title).toBe('Link Text Here');
  });

  it('titleSelector 指定時はリンクテキストにフォールバックしない (titleSelector が無ければ title は null)', async () => {
    const html = `<div class="item"><h2></h2><a href="/x">Link Text</a></div>`;
    const items = await extractItems(toBytes(html), { itemSelector: '.item', titleSelector: 'h2', baseUrl });
    expect(items[0]!.title).toBeNull();
  });

  it('2つ目以降のリンクのテキストは (titleSelector 未指定時の) タイトルに混入しない', async () => {
    const html = `<div class="item"><a href="/first">First Text</a><a href="/second">Second Text</a></div>`;
    const items = await extractItems(toBytes(html), { itemSelector: '.item', baseUrl });
    expect(items[0]!.url).toBe('https://example.com/first');
    expect(items[0]!.title).toBe('First Text');
  });

  it('mailto: 等 http(s) 以外のリンクは採用せず、後続の有効なリンクを探す', async () => {
    const html = `<div class="item"><a href="mailto:x@example.com">mail</a><a href="/real">real</a></div>`;
    const items = await extractItems(toBytes(html), { itemSelector: '.item', baseUrl });
    expect(items[0]!.url).toBe('https://example.com/real');
  });

  it('linkSelector を明示指定できる (既定は a)', async () => {
    const html = `<div class="item"><area href="/area-link"><a href="/anchor-link">go</a></div>`;
    const items = await extractItems(toBytes(html), { itemSelector: '.item', linkSelector: 'area', baseUrl });
    expect(items[0]!.url).toBe('https://example.com/area-link');
  });

  it('タイトルは前後空白をトリムし256字上限で切り詰める', async () => {
    const longTitle = 'あ'.repeat(300);
    const html = `<div class="item"><h2>  ${longTitle}  </h2><a href="/x">go</a></div>`;
    const items = await extractItems(toBytes(html), { itemSelector: '.item', titleSelector: 'h2', baseUrl });
    expect(items[0]!.title).toHaveLength(256);
    expect(items[0]!.title).toBe(longTitle.slice(0, 256));
  });

  it('HTTPヘッダ charset (Shift_JIS) を normalize と同じ decode 経路でベストエフォート復号する', async () => {
    // 'こんにちは' の Shift_JIS バイト列 (test/normalize/normalize.test.ts と同じ最小テーブル方式)。
    const table: Record<string, [number, number]> = {
      こ: [0x82, 0xb1],
      ん: [0x82, 0xf1],
      に: [0x82, 0xc9],
      ち: [0x82, 0xbf],
      は: [0x82, 0xcd],
    };
    const text = 'こんにちは';
    const bytes: number[] = [];
    for (const ch of text) bytes.push(...table[ch]!);
    const headBytes = new TextEncoder().encode(`<div class="item"><h2>`);
    const tailBytes = new TextEncoder().encode(`</h2><a href="/x">go</a></div>`);
    const full = new Uint8Array([...headBytes, ...bytes, ...tailBytes]);

    const items = await extractItems(full, {
      itemSelector: '.item',
      titleSelector: 'h2',
      baseUrl,
      headerCharset: 'Shift_JIS',
    });
    expect(items[0]!.title).toBe(text);
  });

  it('壊れた (閉じタグの無い) HTML でも例外を投げず、可能な範囲で抽出する', async () => {
    const html = `<div class="item"><h2>Broken<a href="/broken">go`; // 閉じタグ無し
    const items = await extractItems(toBytes(html), { itemSelector: '.item', titleSelector: 'h2', baseUrl });
    expect(items).toHaveLength(1);
    expect(items[0]!.url).toBe('https://example.com/broken');
  });

  it('itemSelector に1件もマッチしない場合は空配列を返す (エラーにしない)', async () => {
    const html = `<div class="not-an-item"><a href="/x">go</a></div>`;
    const items = await extractItems(toBytes(html), { itemSelector: '.item', baseUrl });
    expect(items).toEqual([]);
  });

  it('マッチしたアイテムが全てURL無しの場合も空配列を返す', async () => {
    const html = `<div class="item"><h2>No link</h2></div>`;
    const items = await extractItems(toBytes(html), { itemSelector: '.item', titleSelector: 'h2', baseUrl });
    expect(items).toEqual([]);
  });
});
