import { defineConfig } from 'vitest/config'
import { alias, heavy } from './vitest.config.ts'

// The heavy lane: Docker-backed adapter suites, real ZeroMQ/libp2p sockets, and the
// timing-flaky reconnect suite. Serial forks — these tests carry 3-8s delivery budgets
// that starve under concurrent load, so the lane gets the machine to itself. One redis
// and one rabbitmq are booted for the whole lane in global-docker.ts and injected into
// the files; only rabbitmq-reconnect boots its own container (it restarts it mid-test).
export default defineConfig({
  resolve: { alias },
  test: {
    include: heavy,
    testTimeout: 20_000,
    pool: 'forks',
    fileParallelism: false,
    globalSetup: './packages/server/test/global-docker.ts',
  },
})
