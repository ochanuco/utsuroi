/**
 * DOM構築・整形の共通ユーティリティ。
 *
 * XSS対策方針: APIから来る文字列は必ず textContent (このファイルの `el()` の `text` /
 * テキストノード経由) で描画する。innerHTML を使うのは views/changeDetail.js の
 * unified diff 描画のみで、そこでも `escapeHtml()` を通した値だけを埋め込む。
 */

/** 汎用DOM要素ビルダー。options.text は必ず textContent 経由で設定する (API文字列を渡してよい) */
export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value !== null && value !== undefined && value !== false) node.setAttribute(key, String(value));
    }
  }
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
  if (options.on) {
    for (const [eventName, handler] of Object.entries(options.on)) {
      node.addEventListener(eventName, handler);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  return node;
}

/** コンテナの子要素を全て取り除く */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 差分描画専用のHTMLエスケープ (views/changeDetail.js からのみ使用する) */
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return ch;
    }
  });
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('ja-JP', { hour12: false });
}

export function renderLoading(container) {
  clear(container);
  container.appendChild(el('p', { class: 'loading', text: '読み込み中...' }));
}

export function renderError(container, err) {
  clear(container);
  const message = err && err.message ? err.message : String(err);
  container.appendChild(el('p', { class: 'error', text: `エラー: ${message}` }));
}

/**
 * renderError() と異なり container を clear() しない。ページ全体のコンテナに対して
 * 「既に描画済みの他セクションを消さずにエラーだけ追記したい」場合に使う
 * (renderError をページ全体のコンテナへ使うと、一部セクションの失敗で
 * それまでに描画済みの内容ごと消えてしまうため)。
 */
export function appendError(container, err) {
  const message = err && err.message ? err.message : String(err);
  container.appendChild(el('p', { class: 'error', text: `エラー: ${message}` }));
}

export function section(titleText, children = []) {
  const s = el('div', { class: 'section' });
  if (titleText) s.appendChild(el('h3', { text: titleText }));
  for (const child of children) {
    if (child) s.appendChild(child);
  }
  return s;
}

export function badge(status) {
  return el('span', { class: `badge badge-${status}`, text: status });
}

export function fieldRow(children) {
  return el('div', { class: 'field-row' }, children);
}

let fieldIdCounter = 0;

export function field(labelText, inputNode) {
  const wrap = el('div', { class: 'field' });
  if (!inputNode.id) {
    fieldIdCounter += 1;
    inputNode.id = `field-${fieldIdCounter}`;
  }
  wrap.appendChild(el('label', { attrs: { for: inputNode.id }, text: labelText }));
  wrap.appendChild(inputNode);
  return wrap;
}

/**
 * 一覧取得API応答 { items, total } を受け取り、limit指定によって暗黙に切り捨てられている
 * 場合 (items.length < total) に注記要素を返す。切り捨てが無ければ null。
 */
export function truncationNotice(data) {
  if (!data || typeof data.total !== 'number' || !Array.isArray(data.items)) return null;
  if (data.items.length >= data.total) return null;
  return el('p', { class: 'muted', text: `全${data.total}件中${data.items.length}件を表示` });
}

export function navigate(hash) {
  location.hash = hash;
}
