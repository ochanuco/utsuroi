import type { Env as UtsuroiEnv } from '../src/shared/env';
import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env extends UtsuroiEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
