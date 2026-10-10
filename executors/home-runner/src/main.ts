import { createRunnerFetchService } from './addressPolicy.ts';
import { RunnerClient } from './client.ts';
import { loadConfig } from './config.ts';
import { createHealthServer } from './health.ts';
import { stdoutLogger } from './log.ts';
import { Runner } from './runner.ts';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  stdoutLogger('error', 'invalid configuration', { error: err instanceof Error ? err.message : 'unknown' });
  process.exit(1);
}

const runner = new Runner({
  client: new RunnerClient({
    baseUrl: config.baseUrl,
    accessClientId: config.accessClientId,
    accessClientSecret: config.accessClientSecret,
  }),
  createFetchService: (timeoutMs) => createRunnerFetchService(config, timeoutMs),
  executorId: config.executorId,
  concurrency: config.concurrency,
  version: config.version,
  fetchTimeoutMs: config.fetchTimeoutMs,
});

const health = createHealthServer(() => runner.isHealthy());
health.listen(config.healthPort);
runner.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  stdoutLogger('info', 'signal received', { signal });
  await runner.stop();
  health.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
