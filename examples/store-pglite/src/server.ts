import http from 'node:http'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { gossipsub } from '@libp2p/gossipsub'
import { mdns } from '@libp2p/mdns'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { createLibp2pAdapter, type PubSubLibp2p } from '@super-line/adapter-libp2p'
import { pgliteStoreServer } from '@super-line/store-pglite'
import { contract } from './contract.js'

// One cluster node. compose boots node-1 + node-2 from the same image, differing only by env.
const PORT = Number(process.env.PORT ?? 8801)
const NODE = process.env.NODE_NAME ?? `node-${PORT}`
const PG_URL = process.env.PG_URL ?? 'postgres://postgres:password@localhost:54321/electric'
const ELECTRIC_URL = process.env.ELECTRIC_URL ?? 'http://localhost:3000/v1/shape'

// Writes + strong reads hit the central Postgres; this node's in-memory PGlite replica mirrors the
// `resources` table via Electric and drives live fan-out to LOCAL subscribers (clustering: 'self').
const store = await pgliteStoreServer({ pgUrl: PG_URL, electricUrl: ELECTRIC_URL })

// The STORE needs no adapter — Electric is its cross-node bus. This broker-less libp2p adapter is a
// SEPARATE plane carrying presence + inspector so the Control Center sees the whole cluster (the
// self-store's fan-out never touches the adapter). No extra container, and NO cluster-size knowledge:
// every node runs IDENTICAL code and discovers its peers over mDNS on the shared network — no NODES
// list, no bootstrap, no peer IDs to pre-compute. Ephemeral identity/port: mDNS advertises whatever it gets.
const node = (await createLibp2p({
  addresses: { listen: ['/ip4/0.0.0.0/tcp/0'] },
  transports: [tcp()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  peerDiscovery: [mdns()],
  services: {
    identify: identify(),
    pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
  },
})) as unknown as PubSubLibp2p
// mDNS only emits discovery — it does NOT auto-dial (unlike bootstrap). Dial discovered peers so the
// gossipsub mesh (and presence/inspector fan-out) actually forms. Re-dials to a live peer are no-ops.
node.addEventListener('peer:discovery', (e) => {
  console.log(`[${NODE}] mDNS discovered peer ${e.detail.id.toString().slice(-8)}`)
  void node.dial(e.detail.multiaddrs).catch(() => {})
})

const server = http.createServer()
const srv = createSuperLineServer(contract, {
  nodeName: NODE,
  transports: [webSocketServerTransport({ server, inspector: true })],
  authenticate: () => ({ role: 'user' as const, ctx: {} }),
  identify: () => 'demo', // shared principal: every client reads/writes the same room
  adapter: await createLibp2pAdapter({ node }), // reuse the BYO node for server↔server fan-out
  stores: { docs: store },
  inspector: true, // read-only Control Center channel at /inspect (dev/trusted-network only)
})

// Seed the shared resource once. All nodes share the central Postgres, so the first wins; the rest
// read it strongly (no Electric lag for reads) and the CONFLICT here is expected.
try {
  await srv.store('docs').create('room', { count: 0, by: NODE }, { demo: { read: true, write: true } })
  console.log(`[${NODE}] seeded room`)
} catch {
  console.log(`[${NODE}] room already exists`)
}

server.listen(PORT, () => console.log(`[${NODE}] up on :${PORT} — peers via mDNS, electric=${ELECTRIC_URL}`))
