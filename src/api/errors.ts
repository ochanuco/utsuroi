/**
 * 管理API共通のエラー型。{ error: { code, message } } 形式で応答する。
 */
export type ApiErrorStatus = 400 | 401 | 404 | 405 | 409;

export class ApiError extends Error {
  readonly status: ApiErrorStatus;
  readonly code: string;

  constructor(status: ApiErrorStatus, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function badRequest(code: string, message: string): ApiError {
  return new ApiError(400, code, message);
}

export function notFound(code: string, message: string): ApiError {
  return new ApiError(404, code, message);
}

export function conflict(code: string, message: string): ApiError {
  return new ApiError(409, code, message);
}
