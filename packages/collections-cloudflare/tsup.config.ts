import { defineConfig } from 'tsup'

// ESM only: it runs in workerd. The SQL layer is collections-sqlite's `src/sql.ts`, bundled in — importing that
// package would install better-sqlite3, a native addon a Worker can't load.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  target: 'es2022',
  clean: true,
  external: ['@super-line/core'],
})
