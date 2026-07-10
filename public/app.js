/**
 * Utsuroi 管理UI エントリポイント。
 * トークンゲート (ADMIN_TOKEN 入力 -> localStorage保存 -> GET /api/sites で検証) と
 * ハッシュルータの起動を行う。
 */
import { getToken, setToken, clearToken, verifyToken, setUnauthorizedHandler, ApiError } from './js/api.js';
import { startRouter } from './js/router.js';

// ルート登録 (import副作用でregisterRouteを呼ぶ)
import './js/views/sites.js';
import './js/views/siteDetail.js';
import './js/views/monitorDetail.js';
import './js/views/changeDetail.js';
import './js/views/destinations.js';
import './js/views/auditEvents.js';

const gateEl = document.getElementById('gate');
const appEl = document.getElementById('app');
const gateForm = document.getElementById('gate-form');
const gateInput = document.getElementById('gate-token');
const gateError = document.getElementById('gate-error');
const logoutButton = document.getElementById('logout-button');
const viewEl = document.getElementById('view');

function showGate(message) {
  appEl.classList.add('hidden');
  gateEl.classList.remove('hidden');
  if (message) {
    gateError.textContent = message;
    gateError.classList.remove('hidden');
  } else {
    gateError.classList.add('hidden');
  }
  gateInput.value = '';
  gateInput.focus();
}

function showApp() {
  gateEl.classList.add('hidden');
  appEl.classList.remove('hidden');
  startRouter(viewEl);
}

setUnauthorizedHandler(() => {
  showGate('認証に失敗しました。トークンを再入力してください。');
});

gateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = gateInput.value.trim();
  if (!token) return;
  setToken(token);
  try {
    await verifyToken();
    showApp();
  } catch (err) {
    clearToken();
    showGate(err instanceof ApiError ? err.message : 'ログインに失敗しました');
  }
});

logoutButton.addEventListener('click', () => {
  clearToken();
  showGate();
});

async function boot() {
  const token = getToken();
  if (!token) {
    showGate();
    return;
  }
  try {
    await verifyToken();
    showApp();
  } catch (err) {
    showGate(
      err instanceof ApiError && err.status === 401
        ? '保存されたトークンが無効です。再入力してください。'
        : 'サーバーに接続できません。しばらくしてから再試行してください。'
    );
  }
}

boot();
