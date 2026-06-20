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
    testTimeout: 20_000,
    // The ZeroMQ adapter is a native addon; native modules aren't reliably multi-thread-safe in
    // Vitest's worker_threads (same class of problem as Prisma/bcrypt/canvas), so run each file in
    // a child process (`forks`) — Vitest itself made this the default for this reason. And run files
    // serially: this suite mixes Docker redis (testcontainers), libp2p crypto, and real ZeroMQ
    // sockets, and running those concurrently starves timing-sensitive tests (3s reconnect/round-trip
    // budgets). Serial forks trade wall-clock for determinism — the right call here.
    pool: 'forks',
    fileParallelism: false,
  },
})
