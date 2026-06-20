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
      '@super-line/adapter-libp2p': src('packages/adapter-libp2p/src/index.ts'),
      '@super-line/adapter-zeromq': src('packages/adapter-zeromq/src/index.ts'),
      '@super-line/react': src('packages/react/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    // generous for integration tests (real WS, Docker redis, libp2p crypto) under parallel load
    testTimeout: 20_000,
    // Integration tests (libp2p crypto, redis testcontainers) are CPU-heavy; running one worker
    // per core oversubscribes and starves timing-sensitive tests. Leave the OS/event-loop headroom.
    maxWorkers: '50%',
    minWorkers: 1,
  },
})
