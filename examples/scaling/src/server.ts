import http from 'node:http'
import { createSocketServer } from '@super-line/server'
import { createRedisAdapter } from '@super-line/adapter-redis'
import { sync } from './contract.js'

// One cluster node. compose boots three of these (node-1/2/3) from the same image,
// differing only by env. The shared Redis adapter fans rooms, topics, and the
// cluster event bus out across all three.
const PORT = Number(process.env.PORT ?? 8801)
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const NODE = process.env.NODE_NAME ?? `node-${PORT}`

const server = http.createServer()
let conns = 0

const srv = createSocketServer(sync, {
  server,
  authenticate: () => ({ role: 'user' as const, ctx: {} }),
  adapter: createRedisAdapter(REDIS_URL),
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

server.listen(PORT, () => console.log(`[${NODE}] up on :${PORT} (redis ${REDIS_URL})`))

// flow 2: ONE node publishes a topic on a timer; every client receives it, no matter
// which node holds its socket — the cross-node server→client delivery proof.
if (NODE === 'node-1') {
  let n = 0
  setInterval(() => srv.forRole('user').publish('announce', { from: NODE, text: `announce #${++n}` }), 5000)
}
