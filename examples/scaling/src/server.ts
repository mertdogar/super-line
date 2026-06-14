import http from 'node:http'
import { createSocketServer } from '@super-line/server'
import { createRedisAdapter } from '@super-line/adapter-redis'
import { sync } from './contract.js'

// A single node. Run this twice (different PORT) behind a load balancer; the shared
// Redis adapter makes room broadcasts and topic publishes fan out across both.
//   PORT=8801 pnpm server   (terminal 1)
//   PORT=8802 pnpm server   (terminal 2)
const PORT = Number(process.env.PORT ?? 8801)
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

const server = http.createServer()
const srv = createSocketServer(sync, {
  server,
  authenticate: () => ({}),
  adapter: createRedisAdapter(REDIS_URL),
})

srv.implement({
  join: async ({ room }, _ctx, conn) => {
    srv.room(room).add(conn)
    return { ok: true }
  },
})

server.listen(PORT, () => {
  console.log(`super-line node on ws://localhost:${PORT} (redis ${REDIS_URL})`)
})
