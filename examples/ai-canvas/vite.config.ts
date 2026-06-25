import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Resolve the workspace packages to their source so edits show up without a build step.
export default defineConfig({
  plugins: [react()],
  // the WS transport barrel carries Node-only server code (ws, node:http) that's dead in the browser
  // (we only dial) and tree-shaken, but its `global` reference needs a browser shim to resolve.
  define: { global: 'globalThis' },
  // host: true → listen on 0.0.0.0 so Tailscale / LAN peers can load the page.
  server: { host: true, port: 5373 },
  resolve: {
    alias: {
      '@super-line/core': r('../../packages/core/src/index.ts'),
      '@super-line/client': r('../../packages/client/src/index.ts'),
      '@super-line/react': r('../../packages/react/src/index.ts'),
      '@super-line/store-sync': r('../../packages/store-sync/src/index.ts'),
      // resolve to source so the SPA bundles without a publish/build step
      '@super-line/transport-websocket': r('../../packages/transport-websocket/src/index.ts'),
    },
  },
})
