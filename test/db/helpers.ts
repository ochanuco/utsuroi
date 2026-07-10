import { env } from 'cloudflare:test';
import {
  createDestination,
  createMonitor,
  createSite,
  createSource,
  upsertTarget,
  type DestinationRow,
  type MonitorRow,
  type SiteRow,
  type SourceRow,
  type TargetRow,
} from '../../src/db';

/** DB.DB (D1) binding。テストごとに isolated storage でリセットされる。 */
export function db(): D1Database {
  return env.DB;
}

export interface Fixture {
  site: SiteRow;
  source: SourceRow;
  monitor: MonitorRow;
  target: TargetRow;
  destination: DestinationRow;
}

/** site -> source -> monitor -> target -> destination の一連のフィクスチャを作る */
export async function buildFixture(d: D1Database, overrides: { siteName?: string } = {}): Promise<Fixture> {
  const site = await createSite(d, { name: overrides.siteName ?? 'Example Site' });
  const source = await createSource(d, { siteId: site.id, type: 'page', url: 'https://example.com/' });
  const monitor = await createMonitor(d, { siteId: site.id, sourceId: source.id, intervalSeconds: 3600 });
  const target = await upsertTarget(d, { monitorId: monitor.id, url: 'https://example.com/' });
  const destination = await createDestination(d, {
    name: 'Test Discord',
    webhookUrl: 'https://discord.com/api/webhooks/test',
  });
  return { site, source, monitor, target, destination };
}
