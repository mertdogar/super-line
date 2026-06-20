import http from 'node:http'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { createSuperLineServer, type Conn } from '@super-line/server'
import { createLibp2pAdapter } from '@super-line/adapter-libp2p'
import { chat } from './contract.js'

// One chat node. compose boots two of these (node-1/node-2) from the same image, differing only
// by NODE_NAME. There is NO broker — the nodes peer directly over libp2p gossipsub, so
// room.broadcast and presence cross nodes: a message typed in a tab on node-1 reaches a tab on node-2.
const PORT = Number(process.env.PORT ?? 8787)
const NODE = process.env.NODE_NAME ?? 'node-1'
const P2P_PORT = Number(process.env.P2P_PORT ?? 9001)
const NODES = ['node-1', 'node-2']

// DEMO ONLY: derive a deterministic Ed25519 key from each node name, so every node can compute the
// others' peer IDs and build the bootstrap list with no registry. A real deployment persists keys
// instead — createLibp2pAdapter({ identity: { path: '/var/lib/app/p2p' } }).
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
const roomOf = new Map<Conn, string>()
let seq = 0

const srv = createSuperLineServer(chat, {
  server,
  // no broker: every node joins one shared gossipsub mesh
  adapter: await createLibp2pAdapter({
    identity: myKey,
    listen: [`/ip4/0.0.0.0/tcp/${P2P_PORT}`],
    bootstrap,
  }),
  nodeName: NODE, // surface node-1 / node-2 in the Control Center topology
  inspector: true, // read-only Control Center channel (dev/trusted-network only)
  identify: (conn) => (conn.ctx as { name: string }).name, // surface the chat name cluster-wide
  authenticate: (req) => {
    const name = new URL(req.url ?? '', 'http://localhost').searchParams.get('name')?.trim()
    if (!name) throw new Error('name is required')
    return { role: 'user' as const, ctx: { name } }
  },
  onDisconnect: (conn) => {
    const room = roomOf.get(conn)
    if (!room) return
    roomOf.delete(conn)
    void publishPresence(room, conn.id, 'leave')
  },
})

// Cluster-wide room count from the adapter's presence directory (gossip-replicated, eventually
// consistent). The presence write trails the add/remove (it's fire-and-forget), so reconcile the
// just-changed conn id by hand to avoid an off-by-one. `forRole('user').publish` fans the topic to
// every node; clients filter by room.
const publishPresence = async (room: string, connId: string, change: 'join' | 'leave') => {
  const ids = new Set((await srv.cluster.room(room)).map((c) => c.id))
  if (change === 'join') ids.add(connId)
  else ids.delete(connId)
  srv.forRole('user').publish('presence', { room, count: ids.size })
  return ids.size
}

srv.implement({
  user: {
    join: async ({ room }, _ctx, conn) => {
      srv.room(room).add(conn)
      roomOf.set(conn, room)
      const count = await publishPresence(room, conn.id, 'join')
      return { ok: true, count, node: NODE }
    },
    send: async ({ room, text }, ctx) => {
      seq += 1
      const id = `${NODE}_${seq}` // node-prefixed so ids never collide across nodes
      srv.room(room).broadcast('message', { room, id, text, from: ctx.name, node: NODE, at: Date.now() })
      return { id }
    },
  },
})

server.listen(PORT, () => console.log(`[${NODE}] chat node up on :${PORT} (p2p :${P2P_PORT}, ${bootstrap.length} peers)`))
