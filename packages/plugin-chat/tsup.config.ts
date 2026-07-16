import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  target: 'es2022',
  clean: true,
  external: ['@super-line/core', '@super-line/server', '@super-line/plugin-auth', 'zod'],
})
