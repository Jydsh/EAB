import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const resolvePkg = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@eab/domain': resolvePkg('./packages/domain/src/index.ts'),
      '@eab/authz': resolvePkg('./packages/authz/src/index.ts'),
      '@eab/workspace': resolvePkg('./packages/workspace/src/index.ts'),
      '@eab/storage': resolvePkg('./packages/storage/src/index.ts'),
      '@eab/channel': resolvePkg('./packages/channel/src/index.ts'),
      '@eab/server': resolvePkg('./packages/server/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/test/**/*.test.ts'],
    // dsh-im 兼容层会改写进程级 DSH_HOME 并落盘临时 DSH 目录；用独立 fork 跑，避免污染线程池
    poolMatchGlobs: [['**/dsh-im-compat.test.ts', 'forks']],
    reporters: ['basic'],
  },
})
