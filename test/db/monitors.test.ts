import { describe, expect, it } from 'vitest';
import { createRobotsEvaluation, getMonitor, policyStopMonitor, updateMonitorStatus } from '../../src/db';
import { buildFixture, db } from './helpers';

describe('monitors policy stop (SPEC §9, ADR-0008: blocked_by_robots)', () => {
  it('stops a monitor with stop_reason and robots_evaluation_id, clearing next_run_at', async () => {
    const d = db();
    const { monitor } = await buildFixture(d);
    const evaluation = await createRobotsEvaluation(d, {
      origin: 'https://example.com',
      verdict: 'disallowed',
      robotsUrl: 'https://example.com/robots.txt',
      userAgentGroup: 'utsuroibot',
      matchedRule: 'disallow: /',
    });

    await policyStopMonitor(d, monitor.id, {
      stopReason: 'blocked_by_robots: disallow: /',
      robotsEvaluationId: evaluation.id,
    });

    const stopped = await getMonitor(d, monitor.id);
    expect(stopped?.status).toBe('blocked_by_robots');
    expect(stopped?.stopReason).toBe('blocked_by_robots: disallow: /');
    expect(stopped?.robotsEvaluationId).toBe(evaluation.id);
    expect(stopped?.nextRunAt).toBeNull();
  });

  it('clears stop_reason/robots_evaluation_id when the monitor is resumed', async () => {
    const d = db();
    const { monitor } = await buildFixture(d);
    const evaluation = await createRobotsEvaluation(d, {
      origin: 'https://example.com',
      verdict: 'disallowed',
      robotsUrl: 'https://example.com/robots.txt',
      userAgentGroup: 'utsuroibot',
    });
    await policyStopMonitor(d, monitor.id, { stopReason: 'blocked', robotsEvaluationId: evaluation.id });

    await updateMonitorStatus(d, monitor.id, 'active');

    const resumed = await getMonitor(d, monitor.id);
    expect(resumed?.status).toBe('active');
    expect(resumed?.stopReason).toBeNull();
    expect(resumed?.robotsEvaluationId).toBeNull();
  });
});
