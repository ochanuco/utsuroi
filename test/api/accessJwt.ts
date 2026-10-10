/** Access JWT のテスト用発行器。鍵はテスト内で生成し、JWKS 取得は fetch スタブで差し替える。 */
export const TEST_TEAM_DOMAIN = 'team.example.cloudflareaccess.com';
export const TEST_AUD = 'test-aud-tag';
export const TEST_KID = 'test-kid-1';

const RSA_PARAMS = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
} as const;

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(RSA_PARAMS, true, ['sign', 'verify'])) as CryptoKeyPair;
}

function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function jwksFor(pair: CryptoKeyPair, kid = TEST_KID): Promise<{ keys: unknown[] }> {
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { keys: [{ kty: 'RSA', kid, use: 'sig', alg: 'RS256', n: jwk.n, e: jwk.e }] };
}

export function jwksFetch(jwks: { keys: unknown[] }, calls?: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls?.push(url);
    if (url !== `https://${TEST_TEAM_DOMAIN}/cdn-cgi/access/certs`) return new Response('not found', { status: 404 });
    return Response.json(jwks);
  }) as typeof fetch;
}

export interface SignOptions {
  kid?: string;
  alg?: string;
  /** 署名を壊したいとき用に、署名対象とは別の本文を差し込む */
  signature?: string;
}

export async function signJwt(
  pair: CryptoKeyPair,
  claims: Record<string, unknown>,
  opts: SignOptions = {},
): Promise<string> {
  const header = { alg: opts.alg ?? 'RS256', kid: opts.kid ?? TEST_KID, typ: 'JWT' };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = opts.signature ?? b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${sig}`;
}

export function baseClaims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: `https://${TEST_TEAM_DOMAIN}`,
    aud: [TEST_AUD],
    iat: now,
    nbf: now,
    exp: now + 3600,
    ...extra,
  };
}
