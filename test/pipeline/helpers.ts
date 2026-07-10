import { env } from 'cloudflare:test';
import {
  createDestination,
  createExecutor,
  createFetcher,
  createMonitor,
  createSite,
  createSource,
  createSubscription,
  getFetcher,
  putFetcherPolicy,
  type DestinationRow,
  type MonitorRow,
  type SiteRow,
  type SourceRow,
} from '../../src/db';
import type { HostLimiter } from '../../src/shared/contracts';
import type { Env } from '../../src/shared/env';
import type { ChangeKind, SourceType } from '../../src/shared/types';

/** テスト用に一部フィールドを差し替えた Env を作る (env は cloudflare:test の実バインディング) */
export function fakeEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, ...overrides } as Env;
}

/**
 * テストでは HostObject 自体を経由せず、常に即時許可する HostLimiter を注入する。
 * releaseCalls を渡すと release() 呼び出し (leaseId + opts) を記録する
 * (host lease リーク防止のテスト用、fix: runCheck.ts の try/finally)。
 */
export function grantingLimiter(
  releaseCalls?: Array<{ leaseId: string; opts: unknown }>,
): (origin: string) => HostLimiter {
  let counter = 0;
  return () => ({
    acquire: async () => ({ granted: true, leaseId: `lease-${counter++}`, retryAfterMs: null }),
    release: async (leaseId: string, opts: unknown) => {
      releaseCalls?.push({ leaseId, opts });
    },
  });
}

/** DB.DB (D1) binding。テストごとに isolated storage でリセットされる。 */
export function db(): D1Database {
  return env.DB;
}

/** 'cf-http' Fetcher/Executor は複数 Site から共有されるため、無ければ作る (冪等) */
export async function ensureCfHttpFetcher(d: D1Database): Promise<void> {
  const existing = await getFetcher(d, 'cf-http');
  if (existing) return;
  const executor = await createExecutor(d, { kind: 'cloudflare', name: 'CF HTTP' });
  await createFetcher(d, { id: 'cf-http', executorId: executor.id, fetchMode: 'http' });
}

export interface PipelineFixture {
  site: SiteRow;
  source: SourceRow;
  monitor: MonitorRow;
  destination: DestinationRow;
}

export interface BuildPipelineFixtureOptions {
  sourceType?: SourceType;
  sourceUrl?: string;
  intervalSeconds?: number;
  nextRunAt?: string | null;
  monitorStatus?: MonitorRow['status'];
  /** Subscription を作らない (通知ファンアウトを検証しないテスト向け) */
  skipSubscription?: boolean;
  subscriptionChangeKind?: ChangeKind | null;
}

/** site -> source -> monitor + fetcher policy ('cf-http' 単一) + destination/subscription */
export async function buildPipelineFixture(
  opts: BuildPipelineFixtureOptions = {},
): Promise<PipelineFixture> {
  const d = db();
  const site = await createSite(d, { name: 'Example Site', primaryOrigin: 'https://example.com' });
  const source = await createSource(d, {
    siteId: site.id,
    type: opts.sourceType ?? 'page',
    url: opts.sourceUrl ?? 'https://example.com/',
  });
  const monitor = await createMonitor(d, {
    siteId: site.id,
    sourceId: source.id,
    intervalSeconds: opts.intervalSeconds ?? 3600,
    status: opts.monitorStatus,
    nextRunAt: opts.nextRunAt === undefined ? '2026-07-10T00:00:00.000Z' : opts.nextRunAt,
  });

  await ensureCfHttpFetcher(d);
  await putFetcherPolicy(d, site.id, { allowList: ['cf-http'], orderList: [{ fetcherId: 'cf-http' }] });

  const destination = await createDestination(d, {
    name: 'Discord',
    webhookUrl: 'https://discord.com/api/webhooks/test',
  });
  if (!opts.skipSubscription) {
    // site_id を明示することで、同一テストファイル内の他 fixture (別 site) の Change に
    // 誤って一致しないようにする (D1 は個々の it() 間でリセットされないため)。
    await createSubscription(d, {
      destinationId: destination.id,
      siteId: site.id,
      changeKind: opts.subscriptionChangeKind ?? null,
    });
  }

  return { site, source, monitor, destination };
}

/**
 * runMonitorCheck 内の SSRF (resolveAndCheck) が発行する Cloudflare DoH 解決要求に対し、
 * 公開 IP (example.com の実 IP) を解決結果として返して通過させつつ、それ以外の URL は
 * 個別ハンドラへ委譲する fetch スタブを作る。DO 経由の統合テスト・パイプライン単体テストの
 * 両方で使う。
 *
 * 注意: resolveAndCheck は解決失敗/解決結果0件を fail-closed (deny) として扱う (src/net/ssrf.ts)
 * ため、A レコードには具体的な公開 IP を返す必要がある (旧: Answer 省略で allow だったが、
 * fail-closed 化に伴い他のテストが軒並み ssrf_blocked になるのを防ぐため更新)。
 */
export function routedFetch(
  handlers: Record<string, (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('dns-query')) {
      const isARecordQuery = new URL(url).searchParams.get('type') === 'A';
      const answer = isARecordQuery
        ? [{ name: 'example.com', type: 1, TTL: 60, data: '93.184.216.34' }]
        : [];
      return new Response(JSON.stringify({ Status: 0, Answer: answer }), {
        status: 200,
        headers: { 'content-type': 'application/dns-json' },
      });
    }
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (url.startsWith(prefix)) {
        return handler(input, init);
      }
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}
