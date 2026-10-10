/**
 * RUNNER_EXECUTORS (サービストークンの呼び出し元名 -> executor id) の解釈 (ADR-0023 §4)。
 */

const TOKEN_PREFIX = 'token:';

function parseRunnerExecutors(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const v: unknown = JSON.parse(raw || '{}');
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      for (const [name, executorId] of Object.entries(v)) {
        if (typeof executorId === 'string' && executorId !== '') map.set(name, executorId);
      }
    }
  } catch {
    console.error('runner auth: RUNNER_EXECUTORS is not valid JSON; treating as empty');
  }
  return map;
}

/** caller (`token:<name>`) に対応する executor id。対応表に無い caller (人間を含む) は null */
export function runnerExecutorFor(caller: string, raw: string | undefined): string | null {
  if (!caller.startsWith(TOKEN_PREFIX)) return null;
  return parseRunnerExecutors(raw).get(caller.slice(TOKEN_PREFIX.length)) ?? null;
}

export function isRunnerCaller(caller: string, raw: string | undefined): boolean {
  return runnerExecutorFor(caller, raw) !== null;
}
