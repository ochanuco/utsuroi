import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export function generateKeys(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('ed25519');
}

const b64u = (value: Buffer | string): string => Buffer.from(value).toString('base64url');

export interface TokenOverrides {
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
  body: Buffer;
  now?: number;
  privateKey: KeyObject;
}

export function makeToken(o: TokenOverrides): string {
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  const header = { alg: 'EdDSA', typ: 'JWT', ...o.header };
  const claims = {
    iss: 'utsuroi',
    aud: 'gcp-http',
    iat,
    exp: iat + 30,
    jti: randomUUID(),
    bh: createHash('sha256').update(o.body).digest('base64url'),
    ...o.claims,
  };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const signature = sign(null, Buffer.from(input), o.privateKey);
  return `${input}.${b64u(signature)}`;
}
