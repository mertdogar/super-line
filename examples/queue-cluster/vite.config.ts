import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const nodeUrl = process.env.QUEUE_NODE_URL ?? 'http://localhost:8801'

export default defineConfig({
  plugins: [react()],
  define: { global: 'globalThis' },
  build: { target: 'es2022' },
  resolve: {
    alias: {
      '@super-line/core': source('../../packages/core/src/index.ts'),
      '@super-line/client': source('../../packages/client/src/index.ts'),
      '@super-line/transport-websocket': source('../../packages/transport-websocket/src/index.ts'),
    },
  },
  server: {
    proxy: {
      '/ws': { target: nodeUrl, ws: true },
      '/inspect': { target: nodeUrl, ws: true },
    },
  },
})
