import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { getFetcher, listCheckAttempts, listCheckJobsByMonitor, putFetcherPolicy } from '../../src/db';
import { runMonitorCheck } from '../../src/pipeline/runCheck';
import type { Env } from '../../src/shared/env';
import { buildPipelineFixture, db, fakeEnv, grantingLimiter, routedFetch } from './helpers';

async function signingKeyPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

describe('gcp-http in the fetcher policy', () => {
  it('is seeded by migration 0009', async () => {
    const fetcher = await getFetcher(db(), 'gcp-http');
    expect(fetcher).toMatchObject({ executorId: 'gcp', fetchMode: 'http', region: 'asia-northeast1' });
    const row = await env.DB.prepare("SELECT kind FROM executors WHERE id = 'gcp'").first<{ kind: string }>();
    expect(row?.kind).toBe('cloud_run');
  });

  it('is tried after cf-http returns 403 when the policy allows it', async () => {
    const { monitor, site } = await buildPipelineFixture({ sourceUrl: 'https://example.com/blocked' });
    await putFetcherPolicy(db(), site.id, {
      allowList: ['cf-http', 'gcp-http'],
      orderList: [{ fetcherId: 'cf-http', proceedOn: ['http_403'] }, { fetcherId: 'gcp-http' }],
    });

    let executorCalls = 0;
    const fetchStub = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/blocked': () => new Response('forbidden', { status: 403 }),
      'https://executor.example.test/': () => {
        executorCalls++;
        return new Response(
          JSON.stringify({
            kind: 'response',
            status: 200,
            url: 'https://example.com/blocked',
            contentType: 'text/html',
            headers: { 'content-type': 'text/html' },
            body: btoa('<html><body>ok</body></html>'),
            truncated: false,
            durationMs: 5,
          }),
        );
      },
    });

    const result = await runMonitorCheck(
      fakeEnv({
        NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'],
        GCP_EXECUTOR_URL: 'https://executor.example.test/',
        GCP_EXECUTOR_SIGNING_KEY: await signingKeyPem(),
      }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );

    expect(result.kind).toBe('completed');
    expect(executorCalls).toBe(1);
    const jobs = await listCheckJobsByMonitor(db(), monitor.id);
    const attempts = await listCheckAttempts(db(), jobs[0]!.id);
    expect(attempts.map((a) => [a.fetcherId, a.outcome, a.failureClass])).toEqual([
      ['cf-http', 'failure', 'http_403'],
      ['gcp-http', 'success', null],
    ]);
  });

  it('records internal_error (not proceedable) when GCP_EXECUTOR_URL is empty', async () => {
    const { monitor, site } = await buildPipelineFixture({ sourceUrl: 'https://example.com/only-gcp' });
    await putFetcherPolicy(db(), site.id, { allowList: ['gcp-http'], orderList: [{ fetcherId: 'gcp-http' }] });
    const fetchStub = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
    });
    await runMonitorCheck(
      fakeEnv({ NOTIFY_QUEUE: { send: vi.fn() } as unknown as Env['NOTIFY_QUEUE'], GCP_EXECUTOR_URL: '' }),
      monitor.id,
      { fetch: fetchStub, hostLimiter: grantingLimiter() },
    );
    const jobs = await listCheckJobsByMonitor(db(), monitor.id);
    const attempts = await listCheckAttempts(db(), jobs[0]!.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ fetcherId: 'gcp-http', outcome: 'failure', failureClass: 'internal_error' });
  });
});
