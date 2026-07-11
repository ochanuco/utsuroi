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
        fields: [],
      },
      {
        stableKey: 'https://example.com/two',
        url: 'https://example.com/two',
        title: 'Title Two',
        publishedAt: null,
        updatedAt: null,
        summary: null,
        fields: [],
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

  it('同一URLへ解決される複数アイテムは最初の1件だけを採用する (正規化後一致の重複を含む)', async () => {
    // 2件目は同一hrefの重複、3件目はトラッキングパラメータ付きで正規化後に同一URLになる重複。
    const html = `
      <div class="item"><a href="/dup">First</a></div>
      <div class="item"><a href="/dup">Second</a></div>
      <div class="item"><a href="/dup?utm_source=x">Third</a></div>
      <div class="item"><a href="/other">Other</a></div>`;
    const items = await extractItems(toBytes(html), { itemSelector: '.item', baseUrl });
    expect(items.map((i) => i.url)).toEqual(['https://example.com/dup', 'https://example.com/other']);
    expect(items[0]!.title).toBe('First');
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

  it('fields 未指定時は items[].fields が空配列になり、既存の url/title 抽出は一切変わらない (回帰ゼロ)', async () => {
    const html = `<div class="item"><h2>Regression</h2><a href="/x">go</a></div>`;
    const items = await extractItems(toBytes(html), { itemSelector: '.item', titleSelector: 'h2', baseUrl });
    expect(items).toHaveLength(1);
    expect(items[0]!.fields).toEqual([]);
    expect(items[0]!.title).toBe('Regression');
    expect(items[0]!.url).toBe('https://example.com/x');
  });
});

describe('extractItems: extract.fields セレクタ方式 (ADR-0013)', () => {
  it('アイテム内の最初のマッチのサブツリーテキストを値として抽出する', async () => {
    const html = `<div class="item">
      <a href="/x">go</a>
      <span class="dottable-value">3,980万円</span>
    </div>`;
    const items = await extractItems(toBytes(html), {
      itemSelector: '.item',
      baseUrl,
      fields: [{ name: '価格', selector: '.dottable-value' }],
    });
    expect(items[0]!.fields).toEqual([{ name: '価格', value: '3,980万円' }]);
  });

  it('セレクタが同一アイテム内で複数マッチしても最初のマッチだけを採用する', async () => {
    const html = `<div class="item">
      <a href="/x">go</a>
      <span class="dottable-value">First</span>
      <span class="dottable-value">Second</span>
    </div>`;
    const items = await extractItems(toBytes(html), {
      itemSelector: '.item',
      baseUrl,
      fields: [{ name: '価格', selector: '.dottable-value' }],
    });
    expect(items[0]!.fields).toEqual([{ name: '価格', value: 'First' }]);
  });

  it('セレクタにマッチしないフィールドは結果から省く', async () => {
    const html = `<div class="item"><a href="/x">go</a></div>`;
    const items = await extractItems(toBytes(html), {
      itemSelector: '.item',
      baseUrl,
      fields: [{ name: '価格', selector: '.dottable-value' }],
    });
    expect(items[0]!.fields).toEqual([]);
  });

  it('値は正規化後200文字で切り詰める', async () => {
    const longValue = 'あ'.repeat(300);
    const html = `<div class="item"><a href="/x">go</a><span class="v">${longValue}</span></div>`;
    const items = await extractItems(toBytes(html), {
      itemSelector: '.item',
      baseUrl,
      fields: [{ name: '長い値', selector: '.v' }],
    });
    expect(items[0]!.fields).toEqual([{ name: '長い値', value: longValue.slice(0, 200) }]);
  });
});

describe('extractItems: extract.fields ラベル方式 dt/dd (ADR-0013, SUUMO風フィクスチャ)', () => {
  /**
   * SUUMO一覧の実HTML (ADR-0013 Context) を模したフィクスチャ:
   * - dl が table (tbody > tr > td) の中に入れ子になっている
   * - `<dt>&nbsp;</dt>` のダミーラベル行がある
   * - 値に `<sup>` (面積の m² 表記) を含む
   * - 専用クラス (`.dottable-value`) を持つセレクタ方式フィールドも同じアイテムに混在する
   */
  function suumoLikeItemHtml(): string {
    return `<li class="property_unit">
      <a href="/units/1">詳細を見る</a>
      <div class="dottable"><span class="dottable-value">3,980万円</span></div>
      <table><tbody><tr><td>
        <dl>
          <dt>&nbsp;</dt>
          <dd>ダミー行 (無視される)</dd>
          <dt>所在地</dt>
          <dd>東京都渋谷区</dd>
          <dt>専有面積</dt>
          <dd>52.30m<sup>2</sup></dd>
        </dl>
      </td></tr></tbody></table>
    </li>`;
  }

  const fields = [
    { name: '価格', selector: '.dottable-value' },
    { name: '所在地', label: '所在地' },
    { name: '面積', label: '専有面積' },
    { name: '間取り', label: '間取り' }, // このアイテムには存在しないラベル -> 未マッチで省かれる
  ];

  it('dt のラベルテキストが完全一致する直後の dd を値として抽出する (table入れ子・セレクタ方式との混在を含む)', async () => {
    const html = `<ul>${suumoLikeItemHtml()}</ul>`;
    const items = await extractItems(toBytes(html), { itemSelector: '.property_unit', baseUrl, fields });
    expect(items).toHaveLength(1);
    expect(items[0]!.fields).toEqual([
      { name: '価格', value: '3,980万円' },
      { name: '所在地', value: '東京都渋谷区' },
      { name: '面積', value: '52.30m2' },
      // '間取り' はこのアイテムに存在しないラベルのため省かれる
    ]);
  });

  it('`<dt>&nbsp;</dt>` のようなダミーラベル行は正規化後に空文字になりラベルとして扱わない', async () => {
    // ダミー dt の直後の dd (「ダミー行 (無視される)」) がどのフィールドにも紐付かないことを確認する。
    const html = `<ul>${suumoLikeItemHtml()}</ul>`;
    const items = await extractItems(toBytes(html), {
      itemSelector: '.property_unit',
      baseUrl,
      fields: [{ name: '所在地', label: '所在地' }],
    });
    expect(items[0]!.fields).toEqual([{ name: '所在地', value: '東京都渋谷区' }]);
  });

  it('同一ラベルが複数回出現する場合は最初の一致だけを採用する', async () => {
    const html = `<div class="item">
      <a href="/x">go</a>
      <dl>
        <dt>所在地</dt><dd>First Address</dd>
        <dt>所在地</dt><dd>Second Address</dd>
      </dl>
    </div>`;
    const items = await extractItems(toBytes(html), {
      itemSelector: '.item',
      baseUrl,
      fields: [{ name: '所在地', label: '所在地' }],
    });
    expect(items[0]!.fields).toEqual([{ name: '所在地', value: 'First Address' }]);
  });

  it('ラベルにマッチしないフィールドは結果から省く', async () => {
    const html = `<div class="item"><a href="/x">go</a><dl><dt>所在地</dt><dd>東京都</dd></dl></div>`;
    const items = await extractItems(toBytes(html), {
      itemSelector: '.item',
      baseUrl,
      fields: [{ name: '間取り', label: '間取り' }],
    });
    expect(items[0]!.fields).toEqual([]);
  });

  it('label の値は正規化後200文字で切り詰める', async () => {
    const longValue = 'い'.repeat(300);
    const html = `<div class="item"><a href="/x">go</a><dl><dt>備考</dt><dd>${longValue}</dd></dl></div>`;
    const items = await extractItems(toBytes(html), {
      itemSelector: '.item',
      baseUrl,
      fields: [{ name: '備考', label: '備考' }],
    });
    expect(items[0]!.fields).toEqual([{ name: '備考', value: longValue.slice(0, 200) }]);
  });
});
