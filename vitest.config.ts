import { resolve } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

const src = (p: string) => resolve(import.meta.dirname, p)

export const alias = {
  '@super-line/core': src('packages/core/src/index.ts'),
  '@super-line/server': src('packages/server/src/index.ts'),
  '@super-line/client': src('packages/client/src/index.ts'),
  '@super-line/adapter-redis': src('packages/adapter-redis/src/index.ts'),
  '@super-line/adapter-libp2p': src('packages/adapter-libp2p/src/index.ts'),
  '@super-line/adapter-zeromq': src('packages/adapter-zeromq/src/index.ts'),
  '@super-line/adapter-rabbitmq': src('packages/adapter-rabbitmq/src/index.ts'),
  '@super-line/react': src('packages/react/src/index.ts'),
  '@super-line/plugin-inspector': src('packages/plugin-inspector/src/index.ts'),
  // subpath aliases must precede the bare one — vite matches string aliases by prefix, in order
  '@super-line/plugin-auth/server': src('packages/plugin-auth/src/server.ts'),
  '@super-line/plugin-auth/client': src('packages/plugin-auth/src/client.ts'),
  '@super-line/plugin-auth/react': src('packages/plugin-auth/src/react.tsx'),
  '@super-line/plugin-auth': src('packages/plugin-auth/src/index.ts'),
  '@super-line/plugin-chat/server': src('packages/plugin-chat/src/server.ts'),
  '@super-line/plugin-chat/client': src('packages/plugin-chat/src/client.ts'),
  '@super-line/plugin-chat/react': src('packages/plugin-chat/src/react.tsx'),
  '@super-line/plugin-chat': src('packages/plugin-chat/src/index.ts'),
  '@super-line/collections-memory': src('packages/collections-memory/src/index.ts'),
  '@super-line/collections-crdt-memory': src('packages/collections-crdt-memory/src/index.ts'),
  '@super-line/collections-crdt-libsql': src('packages/collections-crdt-libsql/src/index.ts'),
  '@super-line/collections-crdt-pglite': src('packages/collections-crdt-pglite/src/index.ts'),
  '@super-line/collections-sqlite': src('packages/collections-sqlite/src/index.ts'),
  '@super-line/collections-pglite': src('packages/collections-pglite/src/index.ts'),
  '@super-line/tanstack-db': src('packages/tanstack-db/src/index.ts'),
  '@super-line/store-memory': src('packages/store-memory/src/index.ts'),
  '@super-line/store-pglite': src('packages/store-pglite/src/index.ts'),
  '@super-line/store-sync': src('packages/store-sync/src/index.ts'),
  '@super-line/store-sync-pglite': src('packages/store-sync-pglite/src/index.ts'),
  '@super-line/transport-websocket': src('packages/transport-websocket/src/index.ts'),
  '@super-line/transport-loopback': src('packages/transport-loopback/src/index.ts'),
  '@super-line/transport-http': src('packages/transport-http/src/index.ts'),
  '@super-line/transport-libp2p': src('packages/transport-libp2p/src/index.ts'),
}

// The heavy lane: Docker brokers (testcontainers), real ZeroMQ/libp2p sockets, and the
// timing-flaky reconnect suite — everything that needs the machine to itself. These files
// are excluded here and run serially by vitest.integration.config.ts; `pnpm test` runs
// both lanes. (`.integration.test.ts` alone is not the seam — most of packages/server's
// loopback suites carry that name and are fine in parallel.)
export const heavy = [
  'packages/server/test/bus.redis.integration.test.ts',
  'packages/server/test/redis-*.integration.test.ts',
  'packages/server/test/bus.rabbitmq.integration.test.ts',
  'packages/server/test/rabbitmq-*.integration.test.ts',
  'packages/server/test/zeromq-cluster.integration.test.ts',
  'packages/server/test/libp2p-*.integration.test.ts',
  'packages/server/test/reconnect.integration.test.ts',
  'packages/adapter-zeromq/test/**/*.test.ts',
  'packages/adapter-libp2p/test/**/*.test.ts',
  'packages/transport-libp2p/test/**/*.test.ts',
  'packages/collections-crdt-pglite/test/collections-crdt-pglite.integration.test.ts',
]

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...heavy],
    testTimeout: 20_000,
    // Native addons (better-sqlite3, libsql) aren't reliably multi-thread-safe in Vitest's
    // worker_threads, so run each file in a child process (`forks`). Files run SERIALLY:
    // this lane was tried at 10/5/3/2 parallel forks (2026-07-16) and flaked at every
    // width — the loopback suites' delivery budgets (2-5s waitFor, debounced persistence,
    // SSE polling) assume a quiet machine. Parallelizing this lane means auditing those
    // budgets per file; until then, serial is the correct default.
    pool: 'forks',
    fileParallelism: false,
  },
})
