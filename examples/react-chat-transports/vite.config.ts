import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Resolve the workspace packages to source so the SPA bundles without a publish step.
// `define.global` covers the few global references in the browser libp2p stack; the transport
// packages' Node-only code (e.g. the WS server's Buffer use) is dead in the browser and tree-shaken.
export default defineConfig({
  plugins: [react()],
  define: { global: 'globalThis' },
  build: { target: 'es2022' },
  optimizeDeps: {
    esbuildOptions: { target: 'es2022' },
    include: ['libp2p', '@libp2p/websockets', '@libp2p/identify', '@chainsafe/libp2p-noise', '@chainsafe/libp2p-yamux', '@multiformats/multiaddr'],
  },
  resolve: {
    alias: {
      '@super-line/core': r('../../packages/core/src/index.ts'),
      '@super-line/client': r('../../packages/client/src/index.ts'),
      '@super-line/react': r('../../packages/react/src/index.ts'),
      // the browser only dials, so bundle the CLIENT halves — avoids pulling the server transports'
      // Node-only code (node:crypto/http, ws) into the SPA. (typecheck still uses the barrel via tsconfig paths.)
      '@super-line/transport-websocket': r('../../packages/transport-websocket/src/index.ts'),
      '@super-line/transport-http': r('../../packages/transport-http/src/client.ts'),
      '@super-line/transport-libp2p': r('../../packages/transport-libp2p/src/client.ts'),
    },
  },
  // Local dev (pnpm dev + pnpm server): proxy the WS/HTTP/addr endpoints to the node so the SPA
  // is same-origin. The libp2p dial goes DIRECT to the node's published /ws port, not through here.
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/superline': { target: 'http://localhost:8787' },
      '/libp2p-addr': { target: 'http://localhost:8787' },
      '/inspect': { target: 'ws://localhost:8787', ws: true },
    },
  },
})
