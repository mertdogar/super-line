import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const src = (p: string) => resolve(import.meta.dirname, p)

// The SPA bundles super-line packages from source (no prior build step needed).
export default defineConfig({
  base: './', // relative asset URLs, so a host can serve dist/ under any path prefix
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': src('src'),
      '@super-line/core': src('../core/src/index.ts'),
    },
  },
})
