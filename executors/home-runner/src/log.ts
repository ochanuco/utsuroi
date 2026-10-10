export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type Logger = (level: 'info' | 'warn' | 'error', msg: string, fields?: LogFields) => void;

/** 1 行 1 JSON を標準出力へ書く。呼び出し側は本文・トークン・ヘッダ値をフィールドに入れない */
export const stdoutLogger: Logger = (level, msg, fields) => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })}\n`);
};
