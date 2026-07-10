import { describe, expect, it } from 'vitest';
import { checkUrlForSsrf } from '../../src/net/ssrf';

describe('checkUrlForSsrf', () => {
  it('allows ordinary public https URLs', () => {
    expect(checkUrlForSsrf('https://example.com/path')).toEqual({ allowed: true, reason: null });
  });

  it('allows public URLs on approved non-default ports', () => {
    expect(checkUrlForSsrf('https://example.com:8443/path').allowed).toBe(true);
    expect(checkUrlForSsrf('http://example.com:8080/path').allowed).toBe(true);
  });

  it('rejects non-http(s) schemes', () => {
    const result = checkUrlForSsrf('ftp://example.com/file');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('scheme');
  });

  it('rejects file:// scheme', () => {
    expect(checkUrlForSsrf('file:///etc/passwd').allowed).toBe(false);
  });

  it('rejects URLs carrying userinfo', () => {
    const result = checkUrlForSsrf('https://user:pass@example.com/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('userinfo');
  });

  it('rejects disallowed ports', () => {
    const result = checkUrlForSsrf('https://example.com:22/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('port');
  });

  it('rejects invalid URLs', () => {
    expect(checkUrlForSsrf('not a url').allowed).toBe(false);
  });

  it('rejects known loopback hostnames', () => {
    expect(checkUrlForSsrf('http://localhost/').allowed).toBe(false);
    expect(checkUrlForSsrf('http://foo.localhost/').allowed).toBe(false);
  });

  it('rejects known metadata hostnames', () => {
    expect(checkUrlForSsrf('http://metadata.google.internal/computeMetadata/v1/').allowed).toBe(false);
  });

  describe('IPv4 literal ranges', () => {
    it('rejects loopback 127.0.0.0/8', () => {
      const r = checkUrlForSsrf('http://127.0.0.1/');
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('loopback');
    });

    it('rejects RFC1918 private ranges', () => {
      expect(checkUrlForSsrf('http://10.1.2.3/').reason).toBe('private');
      expect(checkUrlForSsrf('http://172.16.0.5/').reason).toBe('private');
      expect(checkUrlForSsrf('http://172.31.255.255/').reason).toBe('private');
      expect(checkUrlForSsrf('http://192.168.1.1/').reason).toBe('private');
    });

    it('allows 172.x outside the 172.16.0.0/12 range', () => {
      expect(checkUrlForSsrf('http://172.32.0.1/').allowed).toBe(true);
      expect(checkUrlForSsrf('http://172.15.0.1/').allowed).toBe(true);
    });

    it('rejects link-local 169.254.0.0/16', () => {
      expect(checkUrlForSsrf('http://169.254.1.1/').reason).toBe('link-local');
    });

    it('rejects the cloud metadata address 169.254.169.254 specifically', () => {
      expect(checkUrlForSsrf('http://169.254.169.254/latest/meta-data/').reason).toBe('metadata');
    });

    it('rejects the CGN range 100.64.0.0/10', () => {
      expect(checkUrlForSsrf('http://100.64.0.1/').reason).toBe('cgn');
      expect(checkUrlForSsrf('http://100.100.0.1/').reason).toBe('cgn');
      expect(checkUrlForSsrf('http://100.127.255.255/').reason).toBe('cgn');
    });

    it('allows just outside the CGN range', () => {
      expect(checkUrlForSsrf('http://100.63.255.255/').allowed).toBe(true);
      expect(checkUrlForSsrf('http://100.128.0.0/').allowed).toBe(true);
    });

    it('rejects multicast (224.0.0.0/4) and reserved (240.0.0.0/4) addresses, including the limited broadcast address', () => {
      expect(checkUrlForSsrf('http://224.0.0.1/').allowed).toBe(false);
      expect(checkUrlForSsrf('http://239.255.255.255/').allowed).toBe(false);
      expect(checkUrlForSsrf('http://240.0.0.1/').allowed).toBe(false);
      expect(checkUrlForSsrf('http://255.255.255.255/').allowed).toBe(false);
    });

    it('allows just outside the multicast/reserved range', () => {
      expect(checkUrlForSsrf('http://223.255.255.255/').allowed).toBe(true);
    });

    it('rejects obfuscated decimal (single-integer) loopback addresses', () => {
      // 2130706433 === 127.0.0.1
      const r = checkUrlForSsrf('http://2130706433/');
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('loopback');
    });

    it('rejects obfuscated octal loopback addresses', () => {
      // 0177.0.0.1 === 127.0.0.1 (octal first octet)
      const r = checkUrlForSsrf('http://0177.0.0.1/');
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('loopback');
    });

    it('rejects obfuscated hex loopback addresses', () => {
      // 0x7f000001 === 127.0.0.1
      const r = checkUrlForSsrf('http://0x7f000001/');
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('loopback');
    });

    it('rejects shorthand dotted forms (a.b -> a.0.0.b style expansion)', () => {
      // 127.1 === 127.0.0.1
      const r = checkUrlForSsrf('http://127.1/');
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('loopback');
    });
  });

  describe('IPv6 literal ranges', () => {
    it('rejects ::1 loopback', () => {
      const r = checkUrlForSsrf('http://[::1]/');
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('loopback');
    });

    it('rejects fe80::/10 link-local', () => {
      expect(checkUrlForSsrf('http://[fe80::1]/').reason).toBe('link-local');
    });

    it('rejects fc00::/7 unique-local (private)', () => {
      expect(checkUrlForSsrf('http://[fc00::1]/').reason).toBe('private');
      expect(checkUrlForSsrf('http://[fd12:3456:789a::1]/').reason).toBe('private');
    });

    it('rejects the AWS IMDSv6 metadata address fd00:ec2::254 specifically', () => {
      expect(checkUrlForSsrf('http://[fd00:ec2::254]/').reason).toBe('metadata');
    });

    it('rejects IPv4-mapped IPv6 addresses using the mapped address rules', () => {
      // ::ffff:127.0.0.1 maps to loopback
      expect(checkUrlForSsrf('http://[::ffff:127.0.0.1]/').reason).toBe('loopback');
      // ::ffff:169.254.169.254 maps to the metadata address
      expect(checkUrlForSsrf('http://[::ffff:169.254.169.254]/').reason).toBe('metadata');
    });

    it('allows a public IPv6 literal', () => {
      expect(checkUrlForSsrf('http://[2606:4700:4700::1111]/').allowed).toBe(true);
    });
  });
});
