/**
 * /api/* 呼び出しの薄いラッパ。認証は Cloudflare Access の Cookie が同一オリジンで自動的に付くため、
 * 認証ヘッダは付けない。
 */

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(30000) });
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new ApiError(0, 'timeout', 'リクエストがタイムアウトしました (30秒)。ネットワークを確認してください。');
    }
    throw err;
  }

  if (res.status === 401) {
    throw new ApiError(401, 'unauthorized', '認証に失敗しました。ページを再読み込みしてログインし直してください。');
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
  patch: (path, body) => request(path, { method: 'PATCH', body: body ?? {} }),
  del: (path) => request(path, { method: 'DELETE' }),
};
