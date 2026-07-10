/**
 * リクエストボディ読み取り・zod検証・ページングの共通ヘルパー。
 */
import type { Context } from 'hono';
import type { ZodType, z } from 'zod';
import { badRequest } from './errors';

/**
 * body を JSON として読み取る。空ボディは {} として扱う。
 * Content-Type が application/json 以外、または不正な JSON は 400 (invalid_json / invalid_content_type)。
 */
export async function readJsonBody(c: Context): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim() === '') return {};

  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw badRequest('invalid_content_type', 'request body must be application/json');
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest('invalid_json', 'request body must be valid JSON');
  }
}

/** zod スキーマで検証し、失敗時は 400 validation_error を投げる */
export function parseWith<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw badRequest('validation_error', message || 'invalid request body');
  }
  return result.data;
}

export interface Pagination {
  limit: number;
  offset: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** limit/offset の簡易ページング。既定 limit=50 */
export function parsePagination(c: Context): Pagination {
  const rawLimit = c.req.query('limit');
  const rawOffset = c.req.query('offset');

  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    const parsed = Number(rawLimit);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      throw badRequest('invalid_pagination', 'limit must be a non-negative integer');
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  let offset = 0;
  if (rawOffset !== undefined) {
    const parsed = Number(rawOffset);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      throw badRequest('invalid_pagination', 'offset must be a non-negative integer');
    }
    offset = parsed;
  }

  return { limit, offset };
}

export function paginate<T>(items: T[], pagination: Pagination): T[] {
  return items.slice(pagination.offset, pagination.offset + pagination.limit);
}

export function methodNotAllowed(c: Context): Response {
  return c.json(
    { error: { code: 'method_not_allowed', message: `method ${c.req.method} not allowed on this route` } },
    405
  );
}
