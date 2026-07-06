import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts', 'src/client.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  target: 'es2022',
  clean: true,
  external: ['@super-line/core', '@super-line/server', '@super-line/client', 'zod'],
})
