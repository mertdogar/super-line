import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { createZeroMqAdapter } from '@super-line/adapter-zeromq'
import { sync } from './contract.js'

// One cluster node. compose boots three of these (node-1/2/3) from the same image,
// differing only by env. There is NO broker — each node binds a PUB and connects a SUB
// to every peer, forming a mesh that fans rooms, topics, and the cluster event bus out.
const PORT = Number(process.env.PORT ?? 8801)
const NODE = process.env.NODE_NAME ?? 'node-1'
const ZMQ_PORT = Number(process.env.ZMQ_PORT ?? 9101)
const NODES = ['node-1', 'node-2', 'node-3']

// Discovery is just DNS names on the compose network — no peer IDs, no registry, no keys.
// ZeroMQ's connect is lazy + auto-reconnecting, so the nodes can start in any order.
const peers = NODES.filter((n) => n !== NODE).map((n) => `tcp://${n}:${ZMQ_PORT}`)

const server = http.createServer()
let conns = 0

const srv = createSuperLineServer(sync, {
  transports: [webSocketServerTransport({ server })],
  authenticate: () => ({ role: 'user' as const, ctx: {} }),
  nodeName: NODE, // surface node-1/2/3 in the Control Center topology
  adapter: await createZeroMqAdapter({ bind: `tcp://0.0.0.0:${ZMQ_PORT}`, peers }),
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

server.listen(PORT, () => console.log(`[${NODE}] up on :${PORT} (zmq :${ZMQ_PORT}, ${peers.length} peers)`))

// flow 2: ONE node publishes a topic on a timer; every client receives it, no matter
// which node holds its socket — the cross-node server→client delivery proof.
if (NODE === 'node-1') {
  let n = 0
  setInterval(() => srv.forRole('user').publish('announce', { from: NODE, text: `announce #${++n}` }), 5000)
}
