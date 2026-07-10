import { describe, expect, it, vi } from 'vitest';
import { resolveAndCheck, type DnsResolver } from '../../src/net/ssrf';

function stubResolver(map: Record<string, { A?: string[]; AAAA?: string[] }>): DnsResolver {
  return {
    async resolve(hostname: string, recordType: 'A' | 'AAAA') {
      const entry = map[hostname];
      if (!entry) return [];
      return (recordType === 'A' ? entry.A : entry.AAAA) ?? [];
    },
  };
}

describe('resolveAndCheck', () => {
  it('allows a hostname that resolves only to public addresses', async () => {
    const resolver = stubResolver({ 'example.com': { A: ['93.184.216.34'], AAAA: ['2606:2800:220:1:248:1893:25c8:1946'] } });
    const result = await resolveAndCheck('https://example.com/', { resolver });
    expect(result).toEqual({ allowed: true, reason: null });
  });

  it('blocks DNS rebinding: hostname resolves to a private IP even though the URL host itself is a public name', async () => {
    const resolver = stubResolver({ 'evil.example.com': { A: ['10.0.0.5'] } });
    const result = await resolveAndCheck('https://evil.example.com/', { resolver });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('private');
  });

  it('blocks when any AAAA answer is a loopback/private address, even if A records are public', async () => {
    const resolver = stubResolver({
      'mixed.example.com': { A: ['203.0.113.10'], AAAA: ['::1'] },
    });
    const result = await resolveAndCheck('https://mixed.example.com/', { resolver });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('loopback');
  });

  it('blocks when the resolved address is the cloud metadata IP', async () => {
    const resolver = stubResolver({ 'metadata.example.com': { A: ['169.254.169.254'] } });
    const result = await resolveAndCheck('https://metadata.example.com/', { resolver });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('metadata');
  });

  it('short-circuits on static checks (scheme) without invoking the resolver', async () => {
    const resolve = vi.fn(async () => []);
    const result = await resolveAndCheck('ftp://example.com/', { resolver: { resolve } });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('scheme');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not call the resolver when the URL host is already an IP literal', async () => {
    const resolve = vi.fn(async () => []);
    const result = await resolveAndCheck('https://93.184.216.34/', { resolver: { resolve } });
    expect(result.allowed).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('uses the injected fetchImpl to talk to the DoH endpoint when no resolver is given', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe('https://cloudflare-dns.com/dns-query');
      const type = url.searchParams.get('type');
      const answer = type === 'A' ? [{ name: 'rebind.example.com', type: 1, TTL: 60, data: '10.1.1.1' }] : [];
      return new Response(JSON.stringify({ Status: 0, Answer: answer }), {
        status: 200,
        headers: { 'content-type': 'application/dns-json' },
      });
    });

    const result = await resolveAndCheck('https://rebind.example.com/', { fetchImpl });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('private');
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('allows when the resolver returns no addresses (cannot determine, defers to actual fetch)', async () => {
    const resolver = stubResolver({});
    const result = await resolveAndCheck('https://nowhere.example.com/', { resolver });
    expect(result.allowed).toBe(true);
  });
});
