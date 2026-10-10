/**
 * Utsuroi 管理UI エントリポイント。
 * 認証は Cloudflare Access (ブラウザの CF_Authorization Cookie) が担うため、UI 側にログイン処理は無い。
 */
import { startRouter } from './js/router.js';

// ルート登録 (import副作用でregisterRouteを呼ぶ)
import './js/views/sites.js';
import './js/views/siteDetail.js';
import './js/views/monitorDetail.js';
import './js/views/changeDetail.js';
import './js/views/destinations.js';
import './js/views/auditEvents.js';
import './js/views/dryRun.js';

startRouter(document.getElementById('view'));
