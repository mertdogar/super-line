import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const src = (p: string) => resolve(import.meta.dirname, p)

// The web app bundles super-line packages from source (no prior build step needed).
// `@super-line/collections-sqlite` is server-only (better-sqlite3) and is NOT aliased here — the
// browser never imports it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': src('src'),
      '@super-line/core': src('../../packages/core/src/index.ts'),
      '@super-line/client': src('../../packages/client/src/index.ts'),
      '@super-line/react': src('../../packages/react/src/index.ts'),
      '@super-line/tanstack-db': src('../../packages/tanstack-db/src/index.ts'),
      '@super-line/transport-websocket': src('../../packages/transport-websocket/src/index.ts'),
      // plugin-auth (browser halves only — /server pulls in node crypto). Subpaths before the bare alias.
      '@super-line/plugin-auth/client': src('../../packages/plugin-auth/src/client.ts'),
      '@super-line/plugin-auth/react': src('../../packages/plugin-auth/src/react.tsx'),
      '@super-line/plugin-auth': src('../../packages/plugin-auth/src/index.ts'),
    },
  },
})
