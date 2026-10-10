/**
 * Fetcher レジストリ (fetcher id -> 実装)。Fetcher Policy が選んだ id をここで実行系へ解決する。
 * 実装は FetchOutcome を返す非同期関数であれば何でもよく、push 型 (cf-http / gcp-http) も、
 * ジョブをキューに積み Runner の結果を待つ pull 型 (home-*) も同じ形で登録できる (ADR-0021)。
 */
import type { FetchOutcome } from '../shared/contracts';
import type { Env } from '../shared/env';
import { gcpHttpFetch } from './gcpHttp';
import { failure, httpFetch } from './http';

export interface FetcherInvocation {
  url: string;
  userAgent: string;
  etag: string | null;
  lastModified: string | null;
  env: Env;
  /** テスト用の fetch 差し替え */
  fetchImpl?: typeof fetch;
  /** 取得する URL (リダイレクト各ホップを含む) の SSRF 検査 */
  urlGuard: (url: string) => { allowed: boolean; reason: string | null };
}

/** 失敗は FetchOutcome で返す。例外を投げた場合は呼び出し側が internal_error に変換する */
export type FetcherImplementation = (invocation: FetcherInvocation) => Promise<FetchOutcome>;

export type FetcherRegistry = ReadonlyMap<string, FetcherImplementation>;

const cfHttp: FetcherImplementation = (inv) =>
  httpFetch(
    { url: inv.url, userAgent: inv.userAgent, etag: inv.etag, lastModified: inv.lastModified },
    // リダイレクト各ホップで URL を再検証する (SPEC §15)。
    { fetch: inv.fetchImpl, urlGuard: inv.urlGuard },
  );

export const defaultFetcherRegistry: FetcherRegistry = new Map<string, FetcherImplementation>([
  ['cf-http', cfHttp],
  ['gcp-http', gcpHttpFetch],
]);

export async function runFetcher(
  registry: FetcherRegistry,
  fetcherId: string,
  invocation: FetcherInvocation,
): Promise<FetchOutcome> {
  const implementation = registry.get(fetcherId);
  if (!implementation) {
    return failure('internal_error', null, `unknown fetcherId: ${fetcherId}`, null);
  }
  try {
    return await implementation(invocation);
  } catch (err) {
    return failure(
      'internal_error',
      null,
      `fetcher ${fetcherId} failed: ${err instanceof Error ? err.message : String(err)}`,
      null,
    );
  }
}
