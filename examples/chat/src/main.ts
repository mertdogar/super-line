import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createSocketServer } from '@super-line/server'
import { createClient } from '@super-line/client'
import { chat } from './contract.js'

// End-to-end dogfood: one server, a human (user) and an AI (agent) in the same room.
// Both share `join` + the `message` event; each has its own posting verb.
async function main(): Promise<void> {
  const server = http.createServer()
  let messageId = 0

  const srv = createSocketServer(chat, {
    server,
    // role + name arrive as query params; the client sends its claimed role automatically
    authenticate: (req) => {
      const u = new URL(req.url ?? '', 'http://localhost')
      const name = u.searchParams.get('name') ?? 'anon'
      return u.searchParams.get('role') === 'agent'
        ? { role: 'agent' as const, ctx: { name } }
        : { role: 'user' as const, ctx: { name } }
    },
  })

  srv.implement({
    shared: {
      join: async ({ room }, _ctx, conn) => {
        srv.room(room).add(conn) // mixed-role room
        return { ok: true }
      },
    },
    user: {
      say: async ({ room, text }, ctx) => {
        srv.room(room).broadcast('message', { room, text, from: ctx.name })
        return { id: `m_${(messageId += 1)}` }
      },
    },
    agent: {
      announce: async ({ room, text }, ctx) => {
        srv.room(room).broadcast('message', { room, text, from: `🤖 ${ctx.name}` })
        return { id: `m_${(messageId += 1)}` }
      },
    },
  })

  await new Promise<void>((resolve) => server.listen(0, resolve))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`

  const alice = createClient(chat, { url, role: 'user', params: { name: 'alice' } })
  const helper = createClient(chat, { url, role: 'agent', params: { name: 'helper' } })

  alice.on('message', (m) => console.log(`  alice sees  -> ${m.from}: ${m.text}`))
  helper.on('message', (m) => console.log(`  helper sees -> ${m.from}: ${m.text}`))

  await alice.join({ room: 'lobby' })
  await helper.join({ room: 'lobby' })

  const sent = await alice.say({ room: 'lobby', text: 'hi everyone' })
  console.log(`  alice sent message ${sent.id}`)
  await helper.announce({ room: 'lobby', text: 'I can help with that.' })

  // alice.announce(...) would be a compile error — that verb belongs to the agent role.

  await new Promise((resolve) => setTimeout(resolve, 200))

  alice.close()
  helper.close()
  await srv.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  console.log('done')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
