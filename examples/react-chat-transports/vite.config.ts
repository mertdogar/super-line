import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Resolve the workspace packages to source so the SPA bundles without a publish step.
// `define.global` covers the few global references in the browser libp2p stack; the transport and
// plugin packages' Node-only code (the WS server's Buffer use, plugin-auth's node:crypto) is only in
// the /server halves, which the browser never imports.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { global: 'globalThis' },
  build: { target: 'es2022' }, // top-level await in src/lib/transport.ts
  optimizeDeps: {
    esbuildOptions: { target: 'es2022' },
    include: ['libp2p', '@libp2p/websockets', '@libp2p/identify', '@chainsafe/libp2p-noise', '@chainsafe/libp2p-yamux', '@multiformats/multiaddr'],
  },
  resolve: {
    alias: {
      '@': r('src'),
      '@super-line/core': r('../../packages/core/src/index.ts'),
      '@super-line/client': r('../../packages/client/src/index.ts'),
      '@super-line/react': r('../../packages/react/src/index.ts'),
      // the browser only dials, so bundle the CLIENT halves — avoids pulling the server transports'
      // and plugins' Node-only code into the SPA. Subpaths before the bare alias.
      '@super-line/transport-websocket': r('../../packages/transport-websocket/src/index.ts'),
      '@super-line/transport-http': r('../../packages/transport-http/src/client.ts'),
      '@super-line/transport-libp2p': r('../../packages/transport-libp2p/src/client.ts'),
      '@super-line/plugin-auth/client': r('../../packages/plugin-auth/src/client.ts'),
      '@super-line/plugin-auth/react': r('../../packages/plugin-auth/src/react.tsx'),
      '@super-line/plugin-auth': r('../../packages/plugin-auth/src/index.ts'),
      '@super-line/plugin-chat/client': r('../../packages/plugin-chat/src/client.ts'),
      '@super-line/plugin-chat/react': r('../../packages/plugin-chat/src/react.tsx'),
      '@super-line/plugin-chat': r('../../packages/plugin-chat/src/index.ts'),
    },
  },
  // Local dev (pnpm dev + pnpm server): proxy the WS/HTTP/addr endpoints to the node so the SPA
  // is same-origin. The libp2p dial goes DIRECT to the node's published /ws port, not through here.
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/superline': { target: 'http://localhost:8787' },
      '/libp2p-addr': { target: 'http://localhost:8787' },
      '/sealed-handoff': { target: 'http://localhost:8787' },
      '/inspect': { target: 'ws://localhost:8787', ws: true },
      '/api': { target: 'http://localhost:8788' }, // the verifier — a DIFFERENT process (pnpm verifier)
    },
  },
})
