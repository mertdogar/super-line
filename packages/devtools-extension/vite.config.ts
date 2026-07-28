import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const here = (p: string) => resolve(import.meta.dirname, p)

// An unpacked extension is loaded from disk by path, so every entry must land at a STABLE, predictable
// filename — manifest.json names them literally and cannot follow a content hash.
export default defineConfig({
  // Relative asset URLs: an extension page is served from the extension root, and a relative base keeps
  // the built HTML valid regardless of where Chrome mounts it.
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': here('src'),
      '@super-line/core': here('../core/src/index.ts'),
      '@super-line/client': here('../client/src/index.ts'),
      '@super-line/plugin-devtools': here('../plugin-devtools/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // no minify: an unpacked debug tool is easier to debug unminified, and nothing here ships over a network
    minify: false,
    rollupOptions: {
      input: {
        devtools: here('devtools.html'),
        panel: here('panel.html'),
        'service-worker': here('src/service-worker.ts'),
        relay: here('src/relay.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
