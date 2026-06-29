import http from 'node:http'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { createLibp2pAdapter } from '@super-line/adapter-libp2p'
import { pgliteStoreServer } from '@super-line/store-pglite'
import { contract } from './contract.js'

// One cluster node. compose boots node-1 + node-2 from the same image, differing only by env.
const PORT = Number(process.env.PORT ?? 8801)
const NODE = process.env.NODE_NAME ?? `node-${PORT}`
const P2P_PORT = Number(process.env.P2P_PORT ?? 9001)
const PG_URL = process.env.PG_URL ?? 'postgres://postgres:password@localhost:54321/electric'
const ELECTRIC_URL = process.env.ELECTRIC_URL ?? 'http://localhost:3000/v1/shape'
const NODES = ['node-1', 'node-2']

// Writes + strong reads hit the central Postgres; this node's in-memory PGlite replica mirrors the
// `resources` table via Electric and drives live fan-out to LOCAL subscribers (clustering: 'self').
const store = await pgliteStoreServer({ pgUrl: PG_URL, electricUrl: ELECTRIC_URL })

// The STORE needs no adapter — Electric is its cross-node bus. This broker-less libp2p adapter is a
// SEPARATE plane: it carries presence + inspector + rooms/topics so the Control Center can see the whole
// cluster (the self-store's fan-out never touches the adapter). No extra container — nodes peer directly.
// DEMO ONLY: derive a deterministic Ed25519 key per node name so each can compute the others' peer IDs and
// build the bootstrap list with no registry. A real deployment persists keys via identity:{ path }.
function seedFor(name: string): Uint8Array {
  const seed = new Uint8Array(32)
  new TextEncoder().encodeInto(name, seed)
  return seed
}
const keyFor = (name: string) => generateKeyPairFromSeed('Ed25519', seedFor(name))
const myKey = await keyFor(NODE)
const bootstrap = await Promise.all(
  NODES.filter((n) => n !== NODE).map(
    async (n) => `/dns4/${n}/tcp/${P2P_PORT}/p2p/${peerIdFromPrivateKey(await keyFor(n)).toString()}`,
  ),
)

const server = http.createServer()
const srv = createSuperLineServer(contract, {
  nodeName: NODE,
  transports: [webSocketServerTransport({ server, inspector: true })],
  authenticate: () => ({ role: 'user' as const, ctx: {} }),
  identify: () => 'demo', // shared principal: every client reads/writes the same room
  adapter: await createLibp2pAdapter({ identity: myKey, listen: [`/ip4/0.0.0.0/tcp/${P2P_PORT}`], bootstrap }),
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

server.listen(PORT, () => console.log(`[${NODE}] up on :${PORT} (p2p :${P2P_PORT}, ${bootstrap.length} peers) — electric=${ELECTRIC_URL}`))
