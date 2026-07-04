import http from 'node:http'
import { createSuperLineServer, type Conn } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { inspector } from '@super-line/plugin-inspector'
import { chat } from './contract.js'
import { moderation } from './moderation/server.js'

const PORT = Number(process.env.PORT ?? 8787)

const server = http.createServer()
const counts = new Map<string, number>()
const roomOf = new Map<Conn, string>()
let seq = 0

const adjust = (room: string, delta: number): number => {
  const next = Math.max(0, (counts.get(room) ?? 0) + delta)
  counts.set(room, next)
  return next
}

const srv = createSuperLineServer(chat, {
  transports: [webSocketServerTransport({ server })],
  authenticate: (h) => {
    const name = h.query.name?.trim()
    if (!name) throw new Error('name is required')
    return { role: 'user' as const, ctx: { name, mod: h.query.mod === '1' } }
  },
  // key connections by name so the moderation plugin can push mod.status to a user with toUser(name)
  identify: (conn) => (conn.ctx as { name?: string }).name,
  onDisconnect: (conn) => {
    const room = roomOf.get(conn)
    if (!room) return
    roomOf.delete(conn)
    srv.forRole('user').publish('presence', { room, count: adjust(room, -1) })
  },
  plugins: [
    moderation({ isModerator: (ctx) => (ctx as { mod?: boolean }).mod === true }),
    inspector(), // browse the mod.muted mutelist live in the Control Center's Stores view
  ],
})

// Note: no mod.mute / mod.unmute / mod.list here — the moderation plugin owns them, and its surface
// keys are subtracted from this obligation at compile time. Adding them would be a compile error.
srv.implement({
  user: {
    join: async ({ room }, _ctx, conn) => {
      srv.room(room).add(conn)
      roomOf.set(conn, room)
      const count = adjust(room, 1)
      srv.forRole('user').publish('presence', { room, count })
      return { ok: true, count }
    },
    send: async ({ room, text }, ctx) => {
      seq += 1
      const id = `m_${seq}`
      srv.room(room).broadcast('message', { room, id, text, from: ctx.name, at: Date.now() })
      return { id }
    },
  },
})

server.listen(PORT, () => {
  console.log(`super-line chat (moderation) listening on ws://localhost:${PORT}`)
})
