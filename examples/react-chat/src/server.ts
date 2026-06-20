import http from 'node:http'
import { createSuperLineServer, type Conn } from '@super-line/server'
import { chat } from './contract.js'

const PORT = Number(process.env.PORT ?? 8787)

const server = http.createServer()
const counts = new Map<string, number>()
const roomOf = new Map<Conn, string>()
let seq = 0

const adjust = (room: string, delta: number) => {
  const next = Math.max(0, (counts.get(room) ?? 0) + delta)
  counts.set(room, next)
  return next
}

const srv = createSuperLineServer(chat, {
  server,
  authenticate: (req) => {
    const name = new URL(req.url ?? '', 'http://localhost').searchParams.get('name')?.trim()
    if (!name) throw new Error('name is required')
    return { role: 'user' as const, ctx: { name } }
  },
  onDisconnect: (conn) => {
    const room = roomOf.get(conn)
    if (!room) return
    roomOf.delete(conn)
    srv.forRole('user').publish('presence', { room, count: adjust(room, -1) })
  },
})

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
  console.log(`super-line chat server listening on ws://localhost:${PORT}`)
})
