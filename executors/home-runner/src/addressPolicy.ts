import { isBlockedAddress } from '../../shared/src/addressPolicy.ts';
import { createFetchService } from '../../shared/src/fetcher.ts';
import type { FetchService } from '../../shared/src/fetcher.ts';
import type { Config } from './config.ts';

/** 共有の SSRF 検査に BLOCKED_CIDRS と ALLOW_IPV6 を反映した取得処理を作る */
export function createRunnerFetchService(config: Config, timeoutMs: number = config.fetchTimeoutMs): FetchService {
  return createFetchService({
    maxBytesCap: config.maxBytesCap,
    timeoutMs,
    maxRedirects: 5,
    userAgent: 'utsuroi-home-runner',
    allowIpv6: config.allowIpv6,
    isBlockedAddress: (address) => isBlockedAddress(address, config.blockedCidrs),
  });
}
