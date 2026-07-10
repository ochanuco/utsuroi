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
import type { ChangeKind, SourceType } from '../../src/shared/types';

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
 * runMonitorCheck 内の SSRF (resolveAndCheck) が発行する Cloudflare DoH 解決要求を
 * 「解決結果なし (allow)」として素通りさせつつ、それ以外の URL は個別ハンドラへ委譲する
 * fetch スタブを作る。DO 経由の統合テスト・パイプライン単体テストの両方で使う。
 */
export function routedFetch(
  handlers: Record<string, (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('dns-query')) {
      return new Response(JSON.stringify({ Status: 0 }), {
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
