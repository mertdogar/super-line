import http from 'node:http'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { createLibp2pAdapter } from '@super-line/adapter-libp2p'
import { sync } from './contract.js'

// One cluster node. compose boots three of these (node-1/2/3) from the same image,
// differing only by env. There is NO broker — the nodes peer directly over libp2p
// gossipsub and that single mesh fans rooms, topics, and the cluster event bus out.
const PORT = Number(process.env.PORT ?? 8801)
const NODE = process.env.NODE_NAME ?? 'node-1'
const P2P_PORT = Number(process.env.P2P_PORT ?? 9001)
const NODES = ['node-1', 'node-2', 'node-3']

// DEMO ONLY: derive a deterministic Ed25519 key from each node name, so every node can
// compute the others' peer IDs and build the bootstrap list with no registry. A real
// deployment persists keys instead — `createLibp2pAdapter({ identity: { path: '/var/lib/app/p2p' } })`.
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
let conns = 0

const srv = createSuperLineServer(sync, {
  transports: [webSocketServerTransport({ server })],
  authenticate: () => ({ role: 'user' as const, ctx: {} }),
  // no broker: every node joins one shared gossipsub mesh
  adapter: await createLibp2pAdapter({
    identity: myKey,
    listen: [`/ip4/0.0.0.0/tcp/${P2P_PORT}`],
    bootstrap,
  }),
  onConnection: (conn) => {
    srv.room('global').add(conn) // auto-join: every client lands in one shared room
    srv.publish('stats', { node: NODE, conns: ++conns }) // flow 3: gossip our count over the bus
    console.log(`[${NODE}] + conn (${conns} local)`)
  },
  onDisconnect: () => {
    srv.publish('stats', { node: NODE, conns: --conns })
    console.log(`[${NODE}] - conn (${conns} local)`)
  },
})

// flow 3: hear other nodes' counts. The bus has local echo, so skip our own via meta.from.
srv.subscribe('stats', (s, { from }) => {
  if (from === srv.nodeId) return
  console.log(`[${NODE}] peer ${s.node} → ${s.conns} conns`)
})

// flow 1: a client `say` fans out to everyone in 'global', on every node
srv.implement({
  user: {
    say: async ({ from, text }) => {
      srv.room('global').broadcast('message', { from, text })
      return { ok: true }
    },
  },
})

server.listen(PORT, () => console.log(`[${NODE}] up on :${PORT} (p2p :${P2P_PORT}, ${bootstrap.length} peers)`))

// flow 2: ONE node publishes a topic on a timer; every client receives it, no matter
// which node holds its socket — the cross-node server→client delivery proof.
if (NODE === 'node-1') {
  let n = 0
  setInterval(() => srv.forRole('user').publish('announce', { from: NODE, text: `announce #${++n}` }), 5000)
}
