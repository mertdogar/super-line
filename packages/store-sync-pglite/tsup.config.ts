import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  target: 'es2022',
  clean: true,
  external: ['@super-line/core', '@super-store/store', '@electric-sql/pglite', '@electric-sql/pglite-sync', 'postgres'],
})
