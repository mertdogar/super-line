import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Resolve the workspace packages to their source so edits show up without a build step.
// Only the client-side packages are aliased — the web bundle never imports the plugin's server half.
export default defineConfig({
  plugins: [react()],
  // bind all interfaces so a phone on the same LAN / Tailscale network can load the app
  server: { host: true },
  resolve: {
    alias: {
      '@super-line/core': r('../../packages/core/src/index.ts'),
      '@super-line/client': r('../../packages/client/src/index.ts'),
      '@super-line/react': r('../../packages/react/src/index.ts'),
    },
  },
})
