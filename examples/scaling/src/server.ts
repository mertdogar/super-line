import http from 'node:http'
import { createSocketServer } from '@super-line/server'
import { createRedisAdapter } from '@super-line/adapter-redis'
import { sync } from './contract.js'

// A single node. Run this twice (different PORT) behind a load balancer; the shared
// Redis adapter makes room broadcasts, topic publishes, AND serverToServer events
// fan out across both.
//   PORT=8801 pnpm server   (terminal 1)
//   PORT=8802 pnpm server   (terminal 2)
const PORT = Number(process.env.PORT ?? 8801)
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const NODE = `node-${PORT}`

const server = http.createServer()
let conns = 0

const srv = createSocketServer(sync, {
  server,
  authenticate: () => ({ role: 'user' as const, ctx: {} }),
  adapter: createRedisAdapter(REDIS_URL),
  onConnection: () => {
    conns += 1
    srv.emitServer('stats', { node: NODE, conns }) // tell peer nodes
  },
  onDisconnect: () => {
    conns -= 1
    srv.emitServer('stats', { node: NODE, conns })
  },
})

// hear about the OTHER nodes' connection counts (excludes our own emits)
srv.onServer('stats', (s) => console.log(`[peer] ${s.node} now has ${s.conns} connection(s)`))

srv.implement({
  user: {
    join: async ({ room }, _ctx, conn) => {
      srv.room(room).add(conn)
      return { ok: true }
    },
  },
})

server.listen(PORT, () => {
  console.log(`super-line node ${NODE} on ws://localhost:${PORT} (redis ${REDIS_URL})`)
})
