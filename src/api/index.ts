/**
 * Utsuroi 管理API (Hono)。SPEC §2(目的6), §9.2, §14〜§17, ADR-0009。
 *
 * createApp() は Env バインディングで動く Hono アプリを返す。全 /api/* は Bearer 認証必須。
 */
import { Hono } from 'hono';
import type { Env } from '../shared/env';
import type { MonitorControlFactory } from '../shared/contracts';
import type { DnsResolver } from '../net';
import { bearerAuth } from './auth';
import { ApiError } from './errors';
import { auditEventsRoutes } from './routes/auditEvents';
import { changesRoutes } from './routes/changes';
import { destinationsRoutes } from './routes/destinations';
import { jobsRoutes } from './routes/jobs';
import { monitorsRoutes } from './routes/monitors';
import { sitesRoutes } from './routes/sites';
import { snapshotsRoutes } from './routes/snapshots';
import { sourcesRoutes } from './routes/sources';
import { subscriptionsRoutes } from './routes/subscriptions';

export interface CreateAppOptions {
  /** MonitorObject DO への RPC アダプタ。既定は env.MONITOR_DO を使う薄いラッパ (実運用向け)。
   * テストでは必ずここに fake factory を注入する。 */
  monitorControlFactory?: (env: Env) => MonitorControlFactory;
  /**
   * sources 登録時の SSRF DNS 解決 (resolveAndCheck) に使う resolver。
   * テスト環境では実ネットワークを使えないため、スタブ resolver を注入する。
   * 省略時は resolveAndCheck の既定 (DoH over fetch) を使う。
   */
  ssrfResolver?: DnsResolver;
}

export function createApp(opts: CreateAppOptions = {}): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.use('/api/*', bearerAuth);

  app.route('/api/sites', sitesRoutes());
  app.route('/api/sources', sourcesRoutes({ ssrfResolver: opts.ssrfResolver }));
  app.route('/api/monitors', monitorsRoutes({ monitorControlFactory: opts.monitorControlFactory }));
  app.route('/api/jobs', jobsRoutes());
  app.route('/api/changes', changesRoutes());
  app.route('/api/snapshots', snapshotsRoutes());
  app.route('/api/destinations', destinationsRoutes());
  app.route('/api/subscriptions', subscriptionsRoutes());
  app.route('/api/audit-events', auditEventsRoutes());

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    console.error('unhandled api error', err);
    return c.json({ error: { code: 'internal_error', message: 'internal server error' } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'route not found' } }, 404));

  return app;
}

export { createDefaultMonitorControlFactory } from './monitorControl';
export type { MonitorDoRpc } from './monitorControl';
