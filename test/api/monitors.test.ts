import { describe, expect, it } from 'vitest';
import {
  createCheckAttempt,
  createCheckJobIfNew,
  createExecutor,
  createFetcher,
  createRobotsEvaluation,
  createSite,
  createSource,
  policyStopMonitor,
  upsertTarget,
} from '../../src/db';
import { authHeaders, buildTestApp, createFakeMonitorControlFactory, db, jsonHeaders, testEnv, uniqueName } from './helpers';

async function makeSiteAndSource(type: 'page' | 'rss' = 'page') {
  const site = await createSite(db(), { name: uniqueName('Monitor Site') });
  const source = await createSource(db(), { siteId: site.id, type, url: 'https://example.com/feed' });
  return { site, source };
}

describe('POST/GET /api/monitors', () => {
  it('creates a monitor from a source_id and derives site_id automatically', async () => {
    const { app } = buildTestApp();
    const { site, source } = await makeSiteAndSource();

    const res = await app.request(
      '/api/monitors',
      { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ source_id: source.id, interval_seconds: 3600 }) },
      testEnv()
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.site_id).toBe(site.id);
    expect(body.source_id).toBe(source.id);
    expect(body.status).toBe('active');
  });

  it('returns 404 for an unknown source_id', async () => {
    const { app } = buildTestApp();
    const res = await app.request(
      '/api/monitors',
      { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ source_id: 'nope', interval_seconds: 60 }) },
      testEnv()
    );
    expect(res.status).toBe(404);
  });

  it('GET /:id includes stop_reason and the robots evaluation reference when policy-stopped', async () => {
    const { app } = buildTestApp();
    const { source } = await makeSiteAndSource();
    const createRes = await app.request(
      '/api/monitors',
      { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ source_id: source.id, interval_seconds: 60 }) },
      testEnv()
    );
    const monitor = await createRes.json() as any;

    const evaluation = await createRobotsEvaluation(db(), {
      origin: 'https://example.com',
      verdict: 'disallowed',
      robotsUrl: 'https://example.com/robots.txt',
      userAgentGroup: 'utsuroibot',
      matchedRule: 'disallow: /',
    });
    await policyStopMonitor(db(), monitor.id, { stopReason: 'blocked_by_robots', robotsEvaluationId: evaluation.id });

    const res = await app.request(`/api/monitors/${monitor.id}`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('blocked_by_robots');
    expect(body.stop_reason).toBe('blocked_by_robots');
    expect(body.robots_evaluation_id).toBe(evaluation.id);
    expect(body.robots_evaluation).toMatchObject({ verdict: 'disallowed', matched_rule: 'disallow: /' });
  });

  it('lists monitors by site_id', async () => {
    const { app } = buildTestApp();
    const { site, source } = await makeSiteAndSource();
    await app.request(
      '/api/monitors',
      { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ source_id: source.id, interval_seconds: 60 }) },
      testEnv()
    );

    const res = await app.request(`/api/monitors?site_id=${site.id}`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('requires site_id for the list endpoint (400)', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/monitors', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(400);
  });
});

describe('POST /api/monitors/:id/run', () => {
  it('returns {started:true} when the factory reports started', async () => {
    const fake = createFakeMonitorControlFactory({ runNowResult: { started: true, reason: null } });
    const { app } = buildTestApp({ monitorControlFactory: fake.factory });
    const { source } = await makeSiteAndSource();
    const monitor = await (
      await app.request(
        '/api/monitors',
        { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ source_id: source.id, interval_seconds: 60 }) },
        testEnv()
      )
    ).json() as any;

    const res = await app.request(
      `/api/monitors/${monitor.id}/run`,
      { method: 'POST', headers: authHeaders() },
      testEnv()
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.started).toBe(true);
  });

  it('returns 409 when the factory reports the run could not start (already running)', async () => {
    const fake = createFakeMonitorControlFactory({
      runNowResult: { started: false, reason: 'job already running' },
    });
    const { app } = buildTestApp({ monitorControlFactory: fake.factory });
    const { source } = await makeSiteAndSource();
    const monitor = await (
      await app.request(
        '/api/monitors',
        { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ source_id: source.id, interval_seconds: 60 }) },
        testEnv()
      )
    ).json() as any;

    const res = await app.request(
      `/api/monitors/${monitor.id}/run`,
      { method: 'POST', headers: authHeaders() },
      testEnv()
    );
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('run_not_started');
  });

  it('returns 404 for an unknown monitor id', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/monitors/nope/run', { method: 'POST', headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
  });
});

describe('POST /api/monitors/:id/pause and /resume', () => {
  it('pauses via the factory and updates D1 status, then resumes back to active', async () => {
    const fake = createFakeMonitorControlFactory();
    const { app } = buildTestApp({ monitorControlFactory: fake.factory });
    const { source } = await makeSiteAndSource();
    const monitor = await (
      await app.request(
        '/api/monitors',
        { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ source_id: source.id, interval_seconds: 60 }) },
        testEnv()
      )
    ).json() as any;

    const pauseRes = await app.request(
      `/api/monitors/${monitor.id}/pause`,
      { method: 'POST', headers: authHeaders() },
      testEnv()
    );
    expect(pauseRes.status).toBe(200);
    expect((await pauseRes.json() as any).status).toBe('paused');
    expect(fake.state.paused.has(monitor.id)).toBe(true);

    const resumeRes = await app.request(
      `/api/monitors/${monitor.id}/resume`,
      { method: 'POST', headers: authHeaders() },
      testEnv()
    );
    expect(resumeRes.status).toBe(200);
    expect((await resumeRes.json() as any).status).toBe('active');
    expect(fake.state.paused.has(monitor.id)).toBe(false);
  });
});

describe('GET /api/monitors/:id/status', () => {
  it('returns the status from the injected MonitorControl', async () => {
    const fake = createFakeMonitorControlFactory({
      status: { monitorId: 'placeholder', nextRunAt: '2026-07-11T00:00:00.000Z', running: true, paused: false, lastResult: null },
    });
    const { app } = buildTestApp({ monitorControlFactory: fake.factory });
    const { source } = await makeSiteAndSource();
    const monitor = await (
      await app.request(
        '/api/monitors',
        { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ source_id: source.id, interval_seconds: 60 }) },
        testEnv()
      )
    ).json() as any;

    const res = await app.request(`/api/monitors/${monitor.id}/status`, { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.running).toBe(true);
    expect(body.next_run_at).toBe('2026-07-11T00:00:00.000Z');
  });
});

describe('GET /api/monitors/:id/jobs and /api/jobs/:id/attempts', () => {
  it('returns 404 for jobs of an unknown monitor', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/monitors/nope/jobs', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
  });

  it('returns 404 for attempts of an unknown job', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/jobs/nope/attempts', { headers: authHeaders() }, testEnv());
    expect(res.status).toBe(404);
  });

  it('lists check_jobs history for a monitor and replays fetch attempts for a job (SPEC 目的6)', async () => {
    const { app } = buildTestApp();
    const { source } = await makeSiteAndSource();
    const monitor = await (
      await app.request(
        '/api/monitors',
        { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ source_id: source.id, interval_seconds: 60 }) },
        testEnv()
      )
    ).json() as any;

    const target = await upsertTarget(db(), { monitorId: monitor.id, url: 'https://example.com/feed' });
    const executor = await createExecutor(db(), { kind: 'cloudflare', name: 'CF' });
    const fetcherId = uniqueName('cf-http');
    await createFetcher(db(), { id: fetcherId, executorId: executor.id, fetchMode: 'http' });

    const { row: job } = await createCheckJobIfNew(db(), {
      monitorId: monitor.id,
      scheduledFor: new Date().toISOString(),
      trigger: 'manual',
    });
    await createCheckAttempt(db(), {
      checkJobId: job.id,
      targetId: target.id,
      fetcherId,
      attemptIndex: 0,
      outcome: 'success',
      statusCode: 200,
    });

    const jobsRes = await app.request(`/api/monitors/${monitor.id}/jobs`, { headers: authHeaders() }, testEnv());
    expect(jobsRes.status).toBe(200);
    const jobsBody = await jobsRes.json() as any;
    expect(jobsBody.items).toHaveLength(1);
    expect(jobsBody.items[0].id).toBe(job.id);

    const attemptsRes = await app.request(`/api/jobs/${job.id}/attempts`, { headers: authHeaders() }, testEnv());
    expect(attemptsRes.status).toBe(200);
    const attemptsBody = await attemptsRes.json() as any;
    expect(attemptsBody.items).toHaveLength(1);
    expect(attemptsBody.items[0]).toMatchObject({ fetcher_id: fetcherId, outcome: 'success', status_code: 200 });
  });
});
