import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const src = (p: string) => resolve(import.meta.dirname, p)

export default defineConfig({
  resolve: {
    alias: {
      '@super-line/core': src('packages/core/src/index.ts'),
      '@super-line/server': src('packages/server/src/index.ts'),
      '@super-line/client': src('packages/client/src/index.ts'),
      '@super-line/adapter-redis': src('packages/adapter-redis/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    testTimeout: 10_000,
  },
})
