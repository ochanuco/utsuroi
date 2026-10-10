import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { test } from 'node:test';
import { AuthError, JtiCache, verifyRequestToken } from '../src/jwt.ts';
import { generateKeys, makeToken } from './helpers.ts';

const body = Buffer.from('{"url":"https://example.com/"}');
const keys = generateKeys();

function check(token: string, opts: { now?: number; cache?: JtiCache; requestBody?: Buffer } = {}) {
  verifyRequestToken(`Bearer ${token}`, opts.requestBody ?? body, {
    publicKey: keys.publicKey,
    jtiCache: opts.cache ?? new JtiCache(),
    now: opts.now ? () => opts.now! : undefined,
  });
}

const tok = (extra: Partial<Parameters<typeof makeToken>[0]> = {}) =>
  makeToken({ body, privateKey: keys.privateKey, ...extra });

test('accepts a valid token', () => {
  check(tok());
});

test('rejects missing or non-bearer authorization', () => {
  assert.throws(() => verifyRequestToken(undefined, body, { publicKey: keys.publicKey, jtiCache: new JtiCache() }), AuthError);
  assert.throws(() => verifyRequestToken('Basic abc', body, { publicKey: keys.publicKey, jtiCache: new JtiCache() }), AuthError);
});

test('rejects alg other than EdDSA', () => {
  assert.throws(() => check(tok({ header: { alg: 'none' } })), AuthError);
  assert.throws(() => check(tok({ header: { alg: 'HS256' } })), AuthError);
  assert.throws(() => check(tok({ header: { alg: 'RS256' } })), AuthError);
});

test('rejects a token signed by another key', () => {
  const other = generateKeys();
  assert.throws(() => check(makeToken({ body, privateKey: other.privateKey })), AuthError);
});

test('rejects tampered payload', () => {
  const [h, , s] = tok().split('.') as [string, string, string];
  const forged = Buffer.from(JSON.stringify({ iss: 'utsuroi', aud: 'gcp-http', iat: 1, exp: 2, jti: 'aaaaaaaa', bh: 'x' })).toString('base64url');
  assert.throws(() => check(`${h}.${forged}.${s}`), AuthError);
});

test('rejects malformed tokens', () => {
  assert.throws(() => check('a.b'), AuthError);
  assert.throws(() => check('a.b.c.d'), AuthError);
  assert.throws(() => check('!!.!!.!!'), AuthError);
});

test('rejects wrong iss and aud', () => {
  assert.throws(() => check(tok({ claims: { iss: 'someone' } })), AuthError);
  assert.throws(() => check(tok({ claims: { aud: 'other' } })), AuthError);
  assert.throws(() => check(tok({ claims: { aud: ['gcp-http'] } })), AuthError);
});

test('enforces exp with small skew', () => {
  const now = Date.now();
  const t = tok({ now });
  check(t, { now: now + 33_000 });
  assert.throws(() => check(t, { now: now + 40_000 }), AuthError);
});

test('rejects iat in the future beyond skew', () => {
  const now = Date.now();
  assert.throws(() => check(tok({ now: now + 20_000 }), { now }), AuthError);
});

test('rejects lifetime over 60 seconds', () => {
  const now = Date.now();
  const iat = Math.floor(now / 1000);
  assert.throws(() => check(tok({ now, claims: { exp: iat + 61 } }), { now }), AuthError);
  check(tok({ now, claims: { exp: iat + 60 } }), { now });
});

test('rejects non-numeric time claims and short jti', () => {
  assert.throws(() => check(tok({ claims: { exp: '9999999999' } })), AuthError);
  assert.throws(() => check(tok({ claims: { jti: 'x' } })), AuthError);
});

test('binds the token to the exact body', () => {
  assert.throws(() => check(tok(), { requestBody: Buffer.from('{"url":"https://example.org/"}') }), AuthError);
});

test('rejects exact replays within the same cache', () => {
  const cache = new JtiCache();
  const t = tok();
  check(t, { cache });
  assert.throws(() => check(t, { cache }), /replayed/);
});

test('does not consume jti when verification fails', () => {
  const cache = new JtiCache();
  const t = tok();
  assert.throws(() => check(t, { cache, requestBody: Buffer.from('x') }), AuthError);
  check(t, { cache });
});

test('rejects signature that is not 64 bytes', () => {
  const [h, p] = tok().split('.') as [string, string];
  assert.throws(() => check(`${h}.${p}.${Buffer.from('short').toString('base64url')}`), AuthError);
  void sign;
});

test('refuses new tokens when the jti cache is full instead of evicting', () => {
  const cache = new JtiCache(1);
  check(tok(), { cache });
  assert.throws(() => check(tok(), { cache }), AuthError);
});
