import http from 'node:http'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { gossipsub } from '@libp2p/gossipsub'
import { mdns } from '@libp2p/mdns'
import { inspector } from '@super-line/plugin-inspector'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { createLibp2pAdapter, type PubSubLibp2p } from '@super-line/adapter-libp2p'
import { crdtPgliteCollections } from '@super-line/collections-crdt-pglite'
import { api } from './contract.js'
import { runAgent } from './agent.js'
import { SCENE_ID } from './scene.js'

// One cluster node. compose boots node-1 + node-2 from the same image, differing only by env.
const PORT = Number(process.env.PORT ?? 8801)
const NODE = process.env.NODE_NAME ?? `node-${PORT}`
const PG_URL = process.env.PG_URL ?? 'postgres://postgres:password@localhost:54321/electric'
const ELECTRIC_URL = process.env.ELECTRIC_URL ?? 'http://localhost:3000/v1/shape'

// The CRDT scene collection: each write is validated against the contract schema, then appended as a Yjs delta
// to the central op-log; Electric streams the op-log to this node's in-memory replica, folded into a super-store
// doc and fanned to LOCAL subscribers (clustering: 'self'). Two nodes editing different shapes MERGE — true CRDT,
// not last-writer-wins. `document` mode makes concurrent field-level edits merge; it must match the contract's
// `crdt` option (and the client's crdtCollectionsClient reads it from the same contract, so they can't drift).
const scenes = await crdtPgliteCollections({ pgUrl: PG_URL, electricUrl: ELECTRIC_URL, docOptions: () => ({ mode: 'document' }) })

// The collection needs no adapter — Electric is its CRDT bus. This broker-less libp2p mesh is a SEPARATE plane
// carrying presence + inspector so the Control Center sees the whole cluster (the collection never touches it).
// No extra container, and NO cluster-size knowledge: every node runs identical code and finds its peers over
// mDNS on the shared network — no node list, no bootstrap, no peer IDs to pre-compute.
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
// mDNS only emits discovery — it does NOT auto-dial (unlike bootstrap). Dial discovered peers so the gossipsub
// mesh (and presence/inspector fan-out) actually forms. Re-dials to a live peer are no-ops.
node.addEventListener('peer:discovery', (e) => {
  console.log(`[${NODE}] mDNS discovered peer ${e.detail.id.toString().slice(-8)}`)
  void node.dial(e.detail.multiaddrs).catch(() => {})
})

const server = http.createServer()
const srv = createSuperLineServer(api, {
  nodeName: NODE,
  transports: [webSocketServerTransport({ server })],
  plugins: [inspector()],
  // the handshake `name` is for the UI only; the ACL principal is shared so every client co-edits one board
  authenticate: (h) => ({ role: 'user' as const, ctx: { name: h.query.name?.trim() || 'anon' } }),
  identify: () => 'demo',
  adapter: await createLibp2pAdapter({ node }), // reuse the BYO node for the presence/inspector plane
  crdtCollections: scenes,
  policies: { scene: { read: () => true, write: () => true } }, // demo: everyone co-edits one board
})

// Seed the shared board once, server-authoritative. All nodes share the central Postgres, so the first wins;
// the rest get CONFLICT (expected) and fold the seed via Electric.
try {
  await srv.collection('scene').create(SCENE_ID, { shapes: {} })
  console.log(`[${NODE}] seeded board`)
} catch {
  console.log(`[${NODE}] board already exists`)
}

let runs = 0
srv.implement({
  user: {
    // The AI co-writer: open a reactive ServerReplica over the canonical scene, let the agent edit it via
    // tools, then release. `origin` stamps the agent's writes (distinct from human edits in the Control Center).
    agentEdit: async ({ prompt }) => {
      // Strong-fold the board first so the agent's getSnapshot() is current even on a node whose Electric replica
      // hasn't caught up yet (open() is synchronous and can't await the fold itself).
      await srv.collection('scene').read(SCENE_ID)
      const replica = srv.collection('scene').open(SCENE_ID, { origin: `agent:${++runs}` })
      try {
        return await runAgent(replica, prompt)
      } finally {
        replica.close()
      }
    },
  },
})

// Bind 0.0.0.0 so the browser (served by Caddy) can dial this node's WS port from the host.
server.listen(PORT, '0.0.0.0', () => console.log(`[${NODE}] ai-canvas-pglite on :${PORT} — peers via mDNS, electric=${ELECTRIC_URL}`))
