import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const src = (p: string) => resolve(import.meta.dirname, p)

// The web app bundles super-line packages FROM SOURCE — no build step, no stale-dist prebundle.
// Server-only packages (collections-sqlite, plugin */server halves) are never imported by the browser.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': src('src'),
      '@super-line/core': src('../../packages/core/src/index.ts'),
      '@super-line/client': src('../../packages/client/src/index.ts'),
      '@super-line/transport-websocket': src('../../packages/transport-websocket/src/index.ts'),
      // subpaths before the bare alias — vite matches string aliases by prefix, in order
      '@super-line/plugin-auth/client': src('../../packages/plugin-auth/src/client.ts'),
      '@super-line/plugin-auth/react': src('../../packages/plugin-auth/src/react.tsx'),
      '@super-line/plugin-auth': src('../../packages/plugin-auth/src/index.ts'),
      '@super-line/plugin-chat/client': src('../../packages/plugin-chat/src/client.ts'),
      '@super-line/plugin-chat/react': src('../../packages/plugin-chat/src/react.tsx'),
      '@super-line/plugin-chat': src('../../packages/plugin-chat/src/index.ts'),
    },
  },
})
