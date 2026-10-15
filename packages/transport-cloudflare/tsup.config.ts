import { defineConfig } from 'tsup'

// ESM only: it runs in workerd, which loads modules, and `cloudflare:workers` exists nowhere else.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  target: 'es2022',
  clean: true,
  external: ['@super-line/core', '@logtape/logtape', 'cloudflare:workers'],
})
