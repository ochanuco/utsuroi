import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';

const base = {
  UTSUROI_BASE_URL: 'https://utsuroi.example.com/',
  CF_ACCESS_CLIENT_ID: 'id.access',
  CF_ACCESS_CLIENT_SECRET: 'secret',
};

test('applies defaults', () => {
  const c = loadConfig(base);
  assert.equal(c.baseUrl, 'https://utsuroi.example.com');
  assert.equal(c.executorId, 'home');
  assert.equal(c.concurrency, 2);
  assert.equal(c.healthPort, 8080);
  assert.equal(c.allowIpv6, false);
  assert.equal(c.version, 'dev');
});

test('reads overrides', () => {
  const c = loadConfig({ ...base, EXECUTOR_ID: 'x', CONCURRENCY: '4', HEALTH_PORT: '9000', ALLOW_IPV6: 'true', GIT_SHA: 'abc', BLOCKED_CIDRS: '203.0.113.7/32' });
  assert.deepEqual([c.executorId, c.concurrency, c.healthPort, c.allowIpv6, c.version], ['x', 4, 9000, true, 'abc']);
  assert.equal(c.blockedCidrs.v4.check('203.0.113.7', 'ipv4'), true);
});

test('requires base url and access credentials', () => {
  for (const name of ['UTSUROI_BASE_URL', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']) {
    assert.throws(() => loadConfig({ ...base, [name]: undefined }), new RegExp(name));
    assert.throws(() => loadConfig({ ...base, [name]: '  ' }), new RegExp(name));
  }
});

test('rejects invalid values', () => {
  assert.throws(() => loadConfig({ ...base, CONCURRENCY: '0' }), /CONCURRENCY/);
  assert.throws(() => loadConfig({ ...base, CONCURRENCY: 'two' }), /CONCURRENCY/);
  assert.throws(() => loadConfig({ ...base, HEALTH_PORT: '70000' }), /HEALTH_PORT/);
  assert.throws(() => loadConfig({ ...base, ALLOW_IPV6: 'maybe' }), /ALLOW_IPV6/);
  assert.throws(() => loadConfig({ ...base, BLOCKED_CIDRS: 'not-a-cidr' }), /invalid CIDR/);
  assert.throws(() => loadConfig({ ...base, UTSUROI_BASE_URL: 'http://utsuroi.example.com' }), /https/);
  assert.throws(() => loadConfig({ ...base, UTSUROI_BASE_URL: 'https://user:pw@utsuroi.example.com' }), /credentials/);
  assert.throws(() => loadConfig({ ...base, UTSUROI_BASE_URL: 'nonsense' }), /valid URL/);
});

test('allows plain http only for loopback', () => {
  assert.equal(loadConfig({ ...base, UTSUROI_BASE_URL: 'http://127.0.0.1:8787' }).baseUrl, 'http://127.0.0.1:8787');
});
