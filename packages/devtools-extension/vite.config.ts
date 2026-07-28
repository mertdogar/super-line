import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

const here = (p: string) => resolve(import.meta.dirname, p)

const { version } = JSON.parse(readFileSync(here('package.json'), 'utf8')) as { version: string }

/**
 * Emits `manifest.json` with the version taken from package.json.
 *
 * The source manifest deliberately has NO `version` key, and it lives here rather than in `public/`
 * so vite cannot copy it verbatim. Nothing auto-updates this extension — a user compares the version
 * Chrome shows against the Releases page — so a manifest version that could drift from the release it
 * was cut from is the one number that must not be hand-maintained twice.
 */
const manifest = (): Plugin => ({
  name: 'super-line-manifest',
  generateBundle() {
    const source = JSON.parse(readFileSync(here('manifest.json'), 'utf8')) as Record<string, unknown>
    this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify({ ...source, version }, null, 2) })
  },
})

// An unpacked extension is loaded from disk by path, so every entry must land at a STABLE, predictable
// filename — manifest.json names them literally and cannot follow a content hash.
export default defineConfig({
  // Relative asset URLs: an extension page is served from the extension root, and a relative base keeps
  // the built HTML valid regardless of where Chrome mounts it.
  base: './',
  plugins: [react(), tailwindcss(), manifest()],
  // The panel renders this so a bug report names the build it came from. Nothing auto-updates here,
  // and the wire-version banner only fires on a protocol change — every other staleness is silent.
  define: { __PANEL_VERSION__: JSON.stringify(version) },
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
