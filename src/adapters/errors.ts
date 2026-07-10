import type { FailureClass } from '../shared/types';

/**
 * Source Adapter 内で発生する解析エラー。
 * throw されず呼び出し側で分類できるよう code / failureClass を保持する。
 * failureClass は常に 'parse_error' 相当 (SPEC §8 の分類体系に対応)。
 */
export type AdapterParseErrorCode =
  | 'invalid_xml'
  | 'unexpected_root'
  | 'unsupported_source_type';

export class AdapterParseError extends Error {
  readonly code: AdapterParseErrorCode;
  readonly failureClass: FailureClass = 'parse_error';

  constructor(code: AdapterParseErrorCode, message: string) {
    super(message);
    this.name = 'AdapterParseError';
    this.code = code;
    // Error のサブクラスを正しく instanceof 判定できるようにする
    Object.setPrototypeOf(this, AdapterParseError.prototype);
  }
}
