import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Workspace packages resolve to source so the SPA bundles without a publish step — and so there is
// exactly ONE copy of core in the bundle (two would break `instanceof SuperLineError`). Subpaths before
// the bare alias. The browser only ever imports the client/react halves, so the transports alias to their
// client entry. `define.global` covers the browser libp2p stack's few `global` references.
export default defineConfig({
  plugins: [react()],
  define: { global: 'globalThis' },
  build: { target: 'es2022' }, // top-level await in src/dial.ts
  optimizeDeps: {
    esbuildOptions: { target: 'es2022' },
    include: ['libp2p', '@libp2p/websockets', '@libp2p/identify', '@chainsafe/libp2p-noise', '@chainsafe/libp2p-yamux', '@multiformats/multiaddr'],
  },
  resolve: {
    alias: {
      '@super-line/core': r('../../packages/core/src/index.ts'),
      '@super-line/client': r('../../packages/client/src/index.ts'),
      '@super-line/react': r('../../packages/react/src/index.ts'),
      '@super-line/transport-websocket': r('../../packages/transport-websocket/src/index.ts'),
      '@super-line/transport-http': r('../../packages/transport-http/src/client.ts'),
      '@super-line/transport-libp2p': r('../../packages/transport-libp2p/src/client.ts'),
      '@super-line/plugin-queue': r('../../packages/plugin-queue/src/index.ts'),
      '@super-line/plugin-devtools': r('../../packages/plugin-devtools/src/index.ts'),
      '@super-line/tanstack-db': r('../../packages/tanstack-db/src/index.ts'),
      '@super-line/plugin-auth/react': r('../../packages/plugin-auth/src/react.tsx'),
      '@super-line/plugin-auth/client': r('../../packages/plugin-auth/src/client.ts'),
      '@super-line/plugin-auth': r('../../packages/plugin-auth/src/index.ts'),
      '@super-line/plugin-chat/react': r('../../packages/plugin-chat/src/react.tsx'),
      '@super-line/plugin-chat/client': r('../../packages/plugin-chat/src/client.ts'),
      '@super-line/plugin-chat': r('../../packages/plugin-chat/src/index.ts'),
    },
  },
  // `pnpm dev` against a node started with `pnpm server` (see README). libp2p dials the node's port directly.
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/superline': { target: 'http://localhost:8787' },
      '/libp2p-addr': { target: 'http://localhost:8787' },
    },
  },
})
