import http from 'node:http'
import { createSocketServer } from '@super-line/server'
import { createRedisAdapter } from '@super-line/adapter-redis'
import { cluster } from './contract.js'

// One cluster node. compose boots three of these from the same image, differing only by env.
// The shared Redis adapter is the bus backbone.
const PORT = Number(process.env.PORT ?? 8801)
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const NODE = process.env.NODE_NAME ?? `node-${PORT}`

const server = http.createServer()
const srv = createSocketServer(cluster, {
  server,
  authenticate: () => ({ role: 'watcher' as const, ctx: {} }),
  adapter: createRedisAdapter(REDIS_URL),
})

// every node keeps its own view of the cluster-wide tally, converged purely from the bus.
const tally: Record<string, number> = {}
const sum = (): number => Object.values(tally).reduce((a, c) => a + c, 0)

// THE SHOWCASE: every node subscribes to `bump`. A node hears its OWN bumps in-process
// (local echo, no Redis round-trip) and its peers' bumps over Redis. `meta.from` is the
// origin node id — proof of where each event came from.
srv.subscribe('bump', (b, { from }) => {
  tally[b.node] = (tally[b.node] ?? 0) + 1
  const origin = from === srv.nodeId ? 'self' : from.slice(0, 8)
  console.log(`[${NODE}] bump ${b.node} (origin ${origin}) → cluster total ${sum()}`, tally)
})

// each node bumps on a timer; the bus delivers it everywhere, including back to this node.
setInterval(() => srv.publish('bump', { node: NODE }), 1500)

// one node publishes the client-facing snapshot so connected watchers see the live total.
if (NODE === 'node-1') {
  setInterval(() => srv.publish('total', { total: sum(), perNode: { ...tally } }), 1500)
}

server.listen(PORT, () => console.log(`[${NODE}] up on :${PORT} (redis ${REDIS_URL})`))
