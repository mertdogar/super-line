import { defineConfig } from 'tsup'

// ESM-only: libp2p is ESM-only, so a CJS build that require()'d it would fail at runtime.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  target: 'es2022',
  clean: true,
  external: [
    '@super-line/core',
    '@chainsafe/libp2p-noise',
    '@chainsafe/libp2p-yamux',
    '@libp2p/bootstrap',
    '@libp2p/config',
    '@libp2p/gossipsub',
    '@libp2p/identify',
    '@libp2p/interface',
    '@libp2p/tcp',
    '@libp2p/websockets',
    'datastore-fs',
    'libp2p',
  ],
})
