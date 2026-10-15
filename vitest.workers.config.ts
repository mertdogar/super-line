import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { alias } from './vitest.config.ts'

// The workers lane: tests that run INSIDE workerd (Miniflare), where a Durable Object can be
// evicted mid-test to prove hibernation. Durable Object WebSockets are not supported with
// per-file storage isolation, so `pnpm test:workers` runs this config with
// `--max-workers=1 --no-isolate` — serial and non-isolated, like the other two lanes.
// `*.workers.test.ts` files are excluded from the fast lane; everything else about the root
// config (aliases to `src/`) is reused.
export default defineConfig({
  resolve: { alias },
  plugins: [cloudflareTest({ wrangler: { configPath: './test-workers/wrangler.jsonc' } })],
  test: {
    include: ['test-workers/**/*.workers.test.ts', 'packages/**/test/**/*.workers.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
})
