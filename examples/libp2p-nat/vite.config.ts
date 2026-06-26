import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { relayMultiaddr, serverPeerId, DISCOVERY_TOPIC } from './src/keys.js'

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

// Compute the deterministic relay multiaddr + public server PeerIds at build time (Node), and inject
// them as constants — so the browser bundle never derives or holds any private key.
const RELAY_HOST = process.env.RELAY_HOST ?? '127.0.0.1'
const SERVER_NODES = (process.env.SERVER_NODES ?? 'node-1,node-2').split(',')
const serverIds = await Promise.all(SERVER_NODES.map(serverPeerId))

export default defineConfig({
  plugins: [react()],
  define: {
    __RELAY_ADDR__: JSON.stringify(relayMultiaddr(RELAY_HOST)),
    __SERVER_PEER_IDS__: JSON.stringify(serverIds),
    __DISCOVERY_TOPIC__: JSON.stringify(DISCOVERY_TOPIC),
    global: 'globalThis', // some libp2p deps reference `global`
  },
  resolve: {
    alias: {
      '@super-line/core': r('../../packages/core/src/index.ts'),
      '@super-line/client': r('../../packages/client/src/index.ts'),
      '@super-line/react': r('../../packages/react/src/index.ts'),
      '@super-line/transport-libp2p': r('../../packages/transport-libp2p/src/index.ts'),
    },
  },
})
