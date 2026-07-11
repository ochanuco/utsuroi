import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      // .claude/worktrees/ 配下 (AIエージェントの隔離worktree) のテストを拾って
      // 二重実行しないようにする。node_modules 等の既定 exclude は configDefaults から継承する。
      exclude: [...configDefaults.exclude, '**/.claude/**'],
    },
  };
});
