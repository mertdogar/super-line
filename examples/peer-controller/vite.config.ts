import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@super-line/core': r('../../packages/core/src/index.ts'),
      '@super-line/client': r('../../packages/client/src/index.ts'),
      '@super-line/plugin-peer/client': r('../../packages/plugin-peer/src/client.ts'),
      '@super-line/plugin-peer': r('../../packages/plugin-peer/src/index.ts'),
      '@super-line/transport-websocket': r('../../packages/transport-websocket/src/index.ts'),
    },
  },
  build: {
    rollupOptions: {
      input: { screen: r('index.html'), controller: r('c/index.html') },
    },
  },
})
