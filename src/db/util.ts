/** src/db/ 内部専用のヘルパー。wave2 には公開しない (index.ts で re-export しない)。 */

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toBool(value: number | boolean | null | undefined): boolean {
  return value === 1 || value === true;
}

export function fromBool(value: boolean | undefined): number {
  return value ? 1 : 0;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // JSON.stringify can return `undefined` (not a string) for values it cannot represent
  // (function, symbol, or an object whose toJSON()/every own property serializes to
  // undefined). D1 bind() expects string | null, so normalize that case to null rather
  // than passing `undefined` through (which TypeScript's lib.d.ts signature hides).
  const result: string | undefined = JSON.stringify(value);
  return typeof result === 'string' ? result : null;
}

/** D1 の `run()` 結果から実際に書き込まれた行数があるかを判定する (INSERT OR IGNORE の冪等判定用) */
export function wasWritten(result: D1Result): boolean {
  return (result.meta?.changes ?? 0) > 0;
}
