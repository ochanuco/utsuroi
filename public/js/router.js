/**
 * ハッシュルーティング。#/path/:param 形式のパターンとハンドラを登録し、
 * hashchange のたびに一致するハンドラへ (container, params, query) を渡して呼ぶ。
 */
import { clear, el, renderError } from './util.js';

const routes = [];

export function registerRoute(pattern, handler) {
  routes.push({ pattern, handler });
}

function matchRoute(path) {
  const pathParts = path.split('/').filter(Boolean);
  for (const { pattern, handler } of routes) {
    const patternParts = pattern.split('/').filter(Boolean);
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < patternParts.length; i++) {
      const part = patternParts[i];
      if (part.startsWith(':')) {
        try {
          params[part.slice(1)] = decodeURIComponent(pathParts[i]);
        } catch {
          // 不正な percent-encoding (例: "%") はこのルートに非マッチとして扱う
          ok = false;
          break;
        }
      } else if (part !== pathParts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler, params };
  }
  return null;
}

let attachedContainer = null;
// hashchangeのたびにインクリメントする世代カウンタ。非同期handlerの完了時にこれが
// 変わっていれば、その間に別のrenderが開始した (=古い結果) とみなし、DOM更新を捨てる。
let renderGeneration = 0;

async function render(container) {
  const generation = ++renderGeneration;
  const hash = location.hash.replace(/^#/, '');
  const [path, queryStr] = hash.split('?');
  const query = new URLSearchParams(queryStr ?? '');
  const match = matchRoute(path || '/sites');

  clear(container);
  if (!match) {
    container.appendChild(el('p', { class: 'empty', text: 'ページが見つかりません' }));
    return;
  }
  try {
    await match.handler(container, match.params, query);
  } catch (err) {
    if (generation !== renderGeneration) return; // 既に新しいrenderが開始済み
    renderError(container, err);
  }
}

/** container は毎回同じノードを渡す前提。複数回呼んでも hashchange リスナーは1つだけ登録する */
export function startRouter(container) {
  if (attachedContainer !== container) {
    attachedContainer = container;
    window.addEventListener('hashchange', () => render(container));
  }
  render(container);
}
