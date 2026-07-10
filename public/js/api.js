/**
 * /api/* 呼び出しの薄いラッパ。ADMIN_TOKEN を localStorage に保存し、
 * Bearer 認証ヘッダを常時付与する。401時は保存済みトークンを破棄し、
 * 登録された unauthorized ハンドラ (トークン再入力画面への遷移) を呼ぶ。
 */

const TOKEN_KEY = 'utsuroi_admin_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

let unauthorizedHandler = () => {};
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

async function request(path, { method = 'GET', body, raw = false } = {}) {
  const token = getToken();
  const headers = { authorization: `Bearer ${token ?? ''}` };
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`/api${path}`, { method, headers, body: payload });

  if (res.status === 401) {
    clearToken();
    unauthorizedHandler();
    throw new ApiError(401, 'unauthorized', '認証に失敗しました。トークンを確認してください。');
  }

  if (!res.ok) {
    // エラー応答は常に {error:{code,message}} のJSON (SPEC契約)。raw (text/plain) 系
    // エンドポイントでも失敗時は同様にJSONエラーを返す実装 (src/api配下参照) なので、
    // ここでは raw フラグに関わらずJSONとして読む。
    let info = null;
    try {
      info = await res.json();
    } catch {
      // JSONで返らない失敗はそのままステータスのみで表現する
    }
    const code = info?.error?.code ?? 'error';
    const message = info?.error?.message ?? `request failed (${res.status})`;
    throw new ApiError(res.status, code, message);
  }

  if (raw) return res.text();

  const text = await res.text();
  if (text === '') return null;
  return JSON.parse(text);
}

export const api = {
  get: (path) => request(path),
  getText: (path) => request(path, { raw: true }),
  post: (path, body) => request(path, { method: 'POST', body: body ?? {} }),
  put: (path, body) => request(path, { method: 'PUT', body: body ?? {} }),
  del: (path) => request(path, { method: 'DELETE' }),
};

/** GET /api/sites を叩いてトークンの有効性を確認する (トークンゲート) */
export async function verifyToken() {
  await request('/sites?limit=1');
}
