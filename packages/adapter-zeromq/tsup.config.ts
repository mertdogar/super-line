import { defineConfig } from 'tsup'

// ESM-only, matching the libp2p adapter; `zeromq` is a native addon kept external.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  target: 'es2022',
  clean: true,
  external: ['@super-line/core', 'zeromq'],
})
