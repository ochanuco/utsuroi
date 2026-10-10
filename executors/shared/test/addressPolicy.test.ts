import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBlockedAddress, isBlockedHostname, parseCidrList } from '../src/addressPolicy.ts';

test('blocks private, loopback, link-local and metadata addresses', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', 'fd00:ec2::254', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '64:ff9b::7f00:1', '2002:7f00:1::1', 'ff02::1',
  ]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
});

test('allows public addresses', () => {
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('blocks unparseable addresses', () => {
  assert.equal(isBlockedAddress('not-an-ip'), true);
});

test('blocks metadata and local hostnames', () => {
  for (const h of ['localhost', 'foo.localhost', 'metadata.google.internal', 'metadata.google.internal.', 'svc.internal', 'printer.local']) {
    assert.equal(isBlockedHostname(h), true, h);
  }
  assert.equal(isBlockedHostname('example.com'), false);
});

test('blocks addresses in extra CIDRs only when given', () => {
  const extra = parseCidrList('93.184.216.0/24, 2606:4700:4700::/48');
  assert.equal(isBlockedAddress('93.184.216.34'), false);
  assert.equal(isBlockedAddress('93.184.216.34', extra), true);
  assert.equal(isBlockedAddress('93.184.217.1', extra), false);
  assert.equal(isBlockedAddress('2606:4700:4700::1111', extra), true);
  assert.equal(isBlockedAddress('2606:4700:4701::1', extra), false);
  assert.equal(isBlockedAddress('10.0.0.1', parseCidrList('')), true);
});

test('rejects malformed CIDR lists', () => {
  for (const bad of ['10.0.0.0', '10.0.0.0/33', 'abc/8', '10.0.0.0/8/8', '::/129', '10.0.0.0/-1']) {
    assert.throws(() => parseCidrList(bad), /invalid CIDR/, bad);
  }
});
