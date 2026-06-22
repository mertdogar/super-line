import http from 'node:http'
import { createSuperLineServer, type Conn } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { createRabbitmqAdapter } from '@super-line/adapter-rabbitmq'
import { chat } from './contract.js'

// One chat node. compose boots two of these (node-1/node-2) from the same image, differing
// only by NODE_NAME. The shared RabbitMQ adapter makes room.broadcast and presence cross nodes,
// so a message typed in a tab on node-1 reaches a tab on node-2 — the broker routes each channel
// only to the nodes that subscribed.
const PORT = Number(process.env.PORT ?? 8787)
const RABBITMQ_URL = process.env.RABBITMQ_URL ?? 'amqp://localhost:5672'
const NODE = process.env.NODE_NAME ?? `node-${PORT}`

const server = http.createServer()
const roomOf = new Map<Conn, string>()
let seq = 0

const srv = createSuperLineServer(chat, {
  transports: [webSocketServerTransport({ server, inspector: true })],
  // createRabbitmqAdapter is async (it connects + declares its topology before returning).
  adapter: await createRabbitmqAdapter(RABBITMQ_URL),
  nodeName: NODE, // surface node-1 / node-2 in the Control Center topology
  inspector: true, // read-only Control Center channel (dev/trusted-network only)
  identify: (conn) => (conn.ctx as { name: string }).name, // surface the chat name cluster-wide
  authenticate: (h) => {
    const name = h.query.name?.trim()
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

server.listen(PORT, () => console.log(`[${NODE}] chat node up on :${PORT} (rabbitmq ${RABBITMQ_URL})`))
