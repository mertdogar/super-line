import http from 'node:http'
import { createSocketServer, type Conn } from '@super-line/server'
import { createZeroMqAdapter } from '@super-line/adapter-zeromq'
import { chat } from './contract.js'

// One chat node. compose boots three of these (node-1/2/3) from the same image, differing only
// by env. There is NO broker — the nodes peer directly over a ZeroMQ mesh, so room.broadcast and
// presence cross nodes: a message typed in a tab on node-1 reaches a tab on node-2. (This is the
// react-chat-cluster example with Redis deleted — same app, one fewer service.)
const PORT = Number(process.env.PORT ?? 8787)
const NODE = process.env.NODE_NAME ?? `node-${PORT}`
const ZMQ_BIND = process.env.ZMQ_BIND ?? 'tcp://0.0.0.0:9101'
const ZMQ_PEERS = (process.env.ZMQ_PEERS ?? '').split(',').filter(Boolean)

const server = http.createServer()
const roomOf = new Map<Conn, string>()
let seq = 0

// async: the ZeroMQ adapter binds its PUB before the server starts.
const adapter = await createZeroMqAdapter({ bind: ZMQ_BIND, peers: ZMQ_PEERS })

const srv = createSocketServer(chat, {
  server,
  adapter,
  nodeName: NODE, // surface node-1 / node-2 / node-3 in the Control Center topology
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

// Cluster-wide room count from the adapter's presence directory. The presence write trails the
// add/remove (it's fire-and-forget), so reconcile the just-changed conn id by hand to avoid an
// off-by-one. `forRole('user').publish` fans the topic to every node; clients filter by room.
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

server.listen(PORT, () => console.log(`[${NODE}] chat node up on :${PORT} (zmq ${ZMQ_BIND}, ${ZMQ_PEERS.length} peers)`))
