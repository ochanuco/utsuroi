import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../shared/env';
import { fetchPage, resolveCaller } from './fetchPage';
import type { FetchPageRequest, FetchPageResult } from './fetchPage';

/**
 * 同一アカウントの他 Worker が Service Binding 越しに取得を依頼する RPC 面 (ADR-0022)。
 * 呼び出し元は binding の `props.caller` で識別する (呼び出された側からは偽装できない)。
 */
export class FetchEntrypoint extends WorkerEntrypoint<Env> {
  async fetchPage(req: FetchPageRequest): Promise<FetchPageResult> {
    const callerName = (this.ctx.props as { caller?: unknown } | undefined)?.caller;
    const caller = resolveCaller(callerName, this.env);
    return fetchPage(req, { env: this.env, caller, callerName: callerName as string });
  }
}
