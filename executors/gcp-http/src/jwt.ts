import { createHash, createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export const EXPECTED_ISSUER = 'utsuroi';
export const EXPECTED_AUDIENCE = 'gcp-http';
export const MAX_TOKEN_LIFETIME_SECONDS = 60;
export const CLOCK_SKEW_SECONDS = 5;

const MAX_JTI_ENTRIES = 10_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class AuthError extends Error {}

export function parsePublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('EXECUTOR_PUBLIC_KEY must be an Ed25519 public key');
  }
  return key;
}

function decodeSegment(segment: string): Buffer {
  if (!BASE64URL.test(segment)) throw new AuthError('malformed token');
  return Buffer.from(segment, 'base64url');
}

function decodeJson(segment: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decodeSegment(segment).toString('utf8'));
  } catch {
    throw new AuthError('malformed token');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AuthError('malformed token');
  }
  return value as Record<string, unknown>;
}

/** 受理済み jti を exp まで覚え、同一インスタンス内での完全な再送を拒否する */
export class JtiCache {
  private readonly entries = new Map<string, number>();

  private readonly maxEntries: number;

  constructor(maxEntries = MAX_JTI_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  /** 初見なら登録して true、既出または満杯なら false */
  claim(jti: string, expSeconds: number, nowSeconds: number): boolean {
    this.purge(nowSeconds);
    if (this.entries.has(jti)) return false;
    // 満杯時は古い jti を捨てると再送を通してしまうため、新規を拒否する (fail closed)。
    if (this.entries.size >= this.maxEntries) return false;
    this.entries.set(jti, expSeconds);
    return true;
  }

  private purge(nowSeconds: number): void {
    for (const [jti, exp] of this.entries) {
      if (exp + CLOCK_SKEW_SECONDS < nowSeconds) this.entries.delete(jti);
    }
  }
}

export interface VerifyOptions {
  publicKey: KeyObject;
  jtiCache: JtiCache;
  now?: () => number;
}

/** 失敗時は AuthError。成功時のみ jti を消費する */
export function verifyRequestToken(authorization: string | undefined, rawBody: Buffer, opts: VerifyOptions): void {
  if (!authorization || !authorization.startsWith('Bearer ')) throw new AuthError('missing bearer token');
  const token = authorization.slice('Bearer '.length).trim();
  const segments = token.split('.');
  if (segments.length !== 3) throw new AuthError('malformed token');
  const [headerSeg, payloadSeg, signatureSeg] = segments as [string, string, string];

  const header = decodeJson(headerSeg);
  if (header.alg !== 'EdDSA') throw new AuthError('unsupported alg');
  if ('crit' in header || 'jku' in header || 'jwk' in header || 'x5u' in header) throw new AuthError('unsupported header');

  const signature = decodeSegment(signatureSeg);
  if (signature.length !== 64) throw new AuthError('bad signature');
  const signingInput = Buffer.from(`${headerSeg}.${payloadSeg}`, 'ascii');
  if (!verify(null, signingInput, opts.publicKey, signature)) throw new AuthError('bad signature');

  const claims = decodeJson(payloadSeg);
  const nowSeconds = Math.floor((opts.now ?? Date.now)() / 1000);
  const { iss, aud, iat, exp, jti, bh } = claims;
  if (iss !== EXPECTED_ISSUER) throw new AuthError('bad iss');
  if (aud !== EXPECTED_AUDIENCE) throw new AuthError('bad aud');
  if (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isFinite(iat) || !Number.isFinite(exp)) {
    throw new AuthError('bad time claims');
  }
  if (exp - iat > MAX_TOKEN_LIFETIME_SECONDS || exp <= iat) throw new AuthError('token lifetime too long');
  if (nowSeconds > exp + CLOCK_SKEW_SECONDS) throw new AuthError('token expired');
  if (iat > nowSeconds + CLOCK_SKEW_SECONDS) throw new AuthError('token not yet valid');
  if (typeof jti !== 'string' || jti.length < 8 || jti.length > 128) throw new AuthError('bad jti');
  if (typeof bh !== 'string') throw new AuthError('bad bh');
  const expectedBh = createHash('sha256').update(rawBody).digest('base64url');
  if (bh !== expectedBh) throw new AuthError('body hash mismatch');

  if (!opts.jtiCache.claim(jti, exp, nowSeconds)) throw new AuthError('replayed token');
}
