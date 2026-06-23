import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Automerge ships a Rust→WASM core, so Vite needs these two plugins to bundle it. This is
// the extra browser setup the Yjs example doesn't need — the bundle/WASM cost ADR-0001 flags.
export default defineConfig({
  plugins: [wasm(), topLevelAwait(), react()],
  resolve: {
    alias: {
      '@super-line/core': r('../../packages/core/src/index.ts'),
      '@super-line/client': r('../../packages/client/src/index.ts'),
      '@super-line/react': r('../../packages/react/src/index.ts'),
    },
  },
})
