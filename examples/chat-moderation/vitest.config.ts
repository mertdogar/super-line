import { defineConfig } from 'vitest/config'
import root from '../../vitest.config.ts'

// Reuse the workspace's @super-line/* → src aliases so the test runs against source (no build step).
// Scoped to this example's own tests; the root `pnpm test` suite is packages-only and skips these.
export default defineConfig({
  resolve: root.resolve,
  test: { include: ['test/**/*.test.ts'] },
})
