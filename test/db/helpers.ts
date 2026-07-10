import { env } from 'cloudflare:test';
import {
  createDestination,
  createMonitor,
  createSite,
  createSource,
  encryptWebhookUrl,
  upsertTarget,
  type DestinationRow,
  type MonitorRow,
  type SiteRow,
  type SourceRow,
  type TargetRow,
} from '../../src/db';

/**
 * destinations.webhook_url 暗号化 (src/db/webhookCrypto.ts) 用の固定テストキー。
 * base64 エンコードされた 32 byte (AES-256-GCM 鍵長)。
 */
export const TEST_WEBHOOK_ENC_KEY = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=';

/** buildFixture が作る destination の平文 webhook URL (notifyStore.test.ts の復号結果比較用) */
export const FIXTURE_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';

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
  const encryptedWebhookUrl = await encryptWebhookUrl(
    FIXTURE_WEBHOOK_URL,
    'discord.com/***test',
    TEST_WEBHOOK_ENC_KEY,
  );
  const destination = await createDestination(d, {
    name: 'Test Discord',
    webhookUrl: encryptedWebhookUrl,
  });
  return { site, source, monitor, target, destination };
}
