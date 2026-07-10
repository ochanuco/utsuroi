/**
 * 全 /api/* に適用する Bearer 認証ミドルウェア (SPEC §9.2 管理操作, ADR-0009 監査対象操作の前提)。
 * env.ADMIN_TOKEN が未設定、または Authorization ヘッダの Bearer トークンが一致しない場合は 401。
 * トークン比較はタイミング攻撃を避けるため定数時間で行う。
 */
import type { Context, Next } from 'hono';
import type { Env } from '../shared/env';

/** "Bearer <token>" のスキーム部分を大文字小文字非依存で受け付ける (RFC 6750 のスキーム名は case-insensitive) */
const BEARER_HEADER_RE = /^Bearer[ \t]+(.+)$/i;

/** 長さの差をできるだけ露呈しない定数時間文字列比較 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length, 1);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    const av = i < aBytes.length ? (aBytes[i] as number) : 0;
    const bv = i < bBytes.length ? (bBytes[i] as number) : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}

export async function bearerAuth(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  const configuredToken = c.env.ADMIN_TOKEN;
  const header = c.req.header('authorization') ?? c.req.header('Authorization') ?? '';
  const provided = BEARER_HEADER_RE.exec(header)?.[1] ?? '';

  if (!configuredToken || provided === '' || !timingSafeEqual(configuredToken, provided)) {
    return c.json({ error: { code: 'unauthorized', message: 'missing or invalid bearer token' } }, 401);
  }

  await next();
}
