/**
 * GCP Executor 向けの短寿命 JWT (EdDSA / Ed25519) を発行する (ADR-0021)。
 * bh クレームでリクエストボディの SHA-256 に束縛するため、トークンの使い回しでは別の URL を取得できない。
 */

export const EXECUTOR_TOKEN_ISSUER = 'utsuroi';
export const EXECUTOR_TOKEN_LIFETIME_SECONDS = 30;

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function pemToDer(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importSigningKey(pem: string): Promise<CryptoKey> {
  let cached = keyCache.get(pem);
  if (!cached) {
    cached = crypto.subtle.importKey('pkcs8', pemToDer(pem), { name: 'Ed25519' }, false, ['sign']);
    cached.catch(() => keyCache.delete(pem));
    keyCache.set(pem, cached);
  }
  return cached;
}

export interface SignExecutorTokenInput {
  signingKeyPem: string;
  audience: string;
  body: Uint8Array;
  nowMs?: number;
}

export async function signExecutorToken(input: SignExecutorTokenInput): Promise<string> {
  const key = await importSigningKey(input.signingKeyPem);
  const iat = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const encoder = new TextEncoder();
  const bodyHash = new Uint8Array(await crypto.subtle.digest('SHA-256', input.body));
  const header = { alg: 'EdDSA', typ: 'JWT' };
  const claims = {
    iss: EXECUTOR_TOKEN_ISSUER,
    aud: input.audience,
    iat,
    exp: iat + EXECUTOR_TOKEN_LIFETIME_SECONDS,
    jti: crypto.randomUUID(),
    bh: base64url(bodyHash),
  };
  const signingInput = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, encoder.encode(signingInput)));
  return `${signingInput}.${base64url(signature)}`;
}
