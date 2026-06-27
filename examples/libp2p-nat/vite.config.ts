import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { relayMultiaddr, relayPeerId, serverPeerId, DISCOVERY_TOPIC } from './src/keys.js'

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

// Compute the deterministic relay multiaddr + public server PeerIds at build time (Node), and inject
// them as constants — so the browser bundle never derives or holds any private key.
const RELAY_HOST = process.env.RELAY_HOST ?? '127.0.0.1'
const SERVER_NODES = (process.env.SERVER_NODES ?? 'node-1,node-2').split(',')
const serverIds = await Promise.all(SERVER_NODES.map(serverPeerId))

// When the page is served over HTTPS (e.g. `tailscale serve` for phone/remote testing), the browser
// can't open a plain ws:// relay (mixed content). Set RELAY_WSS_HOST to point at a wss endpoint that
// TLS-terminates in front of the relay instead.
const RELAY_ADDR = process.env.RELAY_WSS_HOST
  ? `/dns4/${process.env.RELAY_WSS_HOST}/tcp/${process.env.RELAY_WSS_PORT ?? '8443'}/tls/ws/p2p/${relayPeerId}`
  : relayMultiaddr(RELAY_HOST)

export default defineConfig({
  plugins: [react()],
  define: {
    __RELAY_ADDR__: JSON.stringify(RELAY_ADDR),
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
