import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { MonitorObject } from '../../src/do/monitorObject';
import { getMonitor, listChangesByMonitor } from '../../src/db';
import { buildPipelineFixture, db, routedFetch } from '../pipeline/helpers';

function getMonitorStub(monitorId: string): DurableObjectStub<MonitorObject> {
  const id = env.MONITOR_DO.idFromName(monitorId);
  return env.MONITOR_DO.get(id) as unknown as DurableObjectStub<MonitorObject>;
}

describe('MonitorObject: Alarm-driven check (SPEC §10, §11)', () => {
  it('completes a full page check via the Alarm and reschedules the next run', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceUrl: 'https://example.com/do-page',
      nextRunAt: '2099-01-01T00:00:00.000Z',
    });
    const stub = getMonitorStub(monitor.id);

    const fetchStub = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/do-page': () =>
        new Response('<html><body>hello</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });

    // テスト用フック: MonitorObject インスタンスに fetch を注入する (report の設計判断を参照)
    await runInDurableObject(stub, async (instance) => {
      (instance as MonitorObject).testFetch = fetchStub;
    });
    await stub.scheduleMonitor(monitor.id, monitor.nextRunAt);

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const status = await stub.getMonitorStatus(monitor.id);
    expect(status.lastResult?.status).toBe('succeeded');
    expect(status.nextRunAt).not.toBe(monitor.nextRunAt);

    const alarmAfter = await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
    expect(alarmAfter).not.toBeNull();

    const updatedMonitor = await getMonitor(db(), monitor.id);
    expect(updatedMonitor?.lastCheckedAt).toBeTruthy();
  });

  it('robots.txt disallow triggers a Policy Stop and cancels the Alarm', async () => {
    // 別 origin を使う: 'https://example.com' は他の it() でも robots.txt キャッシュ (TTL 1h) と
    // HostObject の最小アクセス間隔状態を共有してしまい (D1/DO はテストファイル内でリセットされない)、
    // この test が期待する Disallow 判定と衝突しうるため。
    const { monitor } = await buildPipelineFixture({
      sourceUrl: 'https://blocked-do.example.net/private/page',
      nextRunAt: '2099-01-01T00:00:00.000Z',
    });
    const stub = getMonitorStub(monitor.id);

    const fetchStub = routedFetch({
      'https://blocked-do.example.net/robots.txt': () =>
        new Response('User-agent: *\nDisallow: /private', { status: 200 }),
    });

    await runInDurableObject(stub, async (instance) => {
      (instance as MonitorObject).testFetch = fetchStub;
    });
    await stub.scheduleMonitor(monitor.id, monitor.nextRunAt);

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const status = await stub.getMonitorStatus(monitor.id);
    expect(status.lastResult?.status).toBe('policy_stopped');

    const alarmAfter = await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
    expect(alarmAfter).toBeNull();

    const updatedMonitor = await getMonitor(db(), monitor.id);
    expect(updatedMonitor?.status).toBe('blocked_by_robots');

    const changes = await listChangesByMonitor(db(), monitor.id);
    expect(changes).toHaveLength(0);
  });

  it('runNow executes immediately even while the monitor is paused', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceUrl: 'https://example.com/do-paused',
      nextRunAt: '2099-01-01T00:00:00.000Z',
    });
    const stub = getMonitorStub(monitor.id);
    await stub.scheduleMonitor(monitor.id, monitor.nextRunAt);
    await stub.pauseMonitor(monitor.id);

    const fetchStub = routedFetch({
      'https://example.com/robots.txt': () => new Response('User-agent: *\nAllow: /', { status: 200 }),
      'https://example.com/do-paused': () =>
        new Response('<html><body>hi</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    await runInDurableObject(stub, async (instance) => {
      (instance as MonitorObject).testFetch = fetchStub;
    });

    const { started, reason } = await stub.runNowMonitor(monitor.id);
    expect(started).toBe(true);
    expect(reason).toBeNull();
  });

  it('a second alarm firing while a check is already running is a defensive no-op (running flag)', async () => {
    const { monitor } = await buildPipelineFixture({
      sourceUrl: 'https://example.com/do-concurrent',
      nextRunAt: '2099-01-01T00:00:00.000Z',
    });
    const stub = getMonitorStub(monitor.id);
    await stub.scheduleMonitor(monitor.id, monitor.nextRunAt);

    // running フラグを直接真にして、alarm() が即 return することを確認する
    await runInDurableObject(stub, async (instance: unknown) => {
      (instance as { running: boolean }).running = true;
    });

    const { started, reason } = await stub.runNowMonitor(monitor.id);
    expect(started).toBe(false);
    expect(reason).toBeTruthy();
  });
});
