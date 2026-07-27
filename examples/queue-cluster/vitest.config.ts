import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@super-line/core': source('../../packages/core/src/index.ts'),
      '@super-line/server': source('../../packages/server/src/index.ts'),
      '@super-line/client': source('../../packages/client/src/index.ts'),
      '@super-line/plugin-queue': source('../../packages/plugin-queue/src/index.ts'),
      '@super-line/collections-memory': source('../../packages/collections-memory/src/index.ts'),
      '@super-line/transport-loopback': source('../../packages/transport-loopback/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
  },
})
