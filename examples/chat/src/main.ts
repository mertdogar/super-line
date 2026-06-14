import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createSocketServer } from '@super-line/server'
import { createClient } from '@super-line/client'
import { chat } from './contract.js'

// End-to-end dogfood: one server, two clients, exercising req/res + room events + topic pub/sub.
async function main(): Promise<void> {
  const server = http.createServer()
  const counts = new Map<string, number>()
  let messageId = 0

  const srv = createSocketServer(chat, {
    server,
    authenticate: (req) => {
      const name = new URL(req.url ?? '', 'http://localhost').searchParams.get('name') ?? 'anon'
      return { name }
    },
  })

  srv.implement({
    join: async ({ room }, _ctx, conn) => {
      srv.room(room).add(conn)
      counts.set(room, (counts.get(room) ?? 0) + 1)
      srv.publish('presence', { room, count: counts.get(room) ?? 0 })
      return { ok: true }
    },
    say: async ({ room, text }, ctx) => {
      srv.room(room).broadcast('message', { room, text, from: ctx.name })
      messageId += 1
      return { id: `m_${messageId}` }
    },
  })

  await new Promise<void>((resolve) => server.listen(0, resolve))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`

  const alice = createClient(chat, { url, params: { name: 'alice' } })
  const bob = createClient(chat, { url, params: { name: 'bob' } })

  alice.on('message', (m) => console.log(`  alice sees -> ${m.from}: ${m.text}`))
  bob.on('message', (m) => console.log(`  bob sees   -> ${m.from}: ${m.text}`))
  alice.subscribe('presence', (p) => console.log(`  [presence] ${p.room}: ${p.count} online`))

  await alice.join({ room: 'lobby' })
  await bob.join({ room: 'lobby' })

  const sent = await alice.say({ room: 'lobby', text: 'hi everyone' })
  console.log(`  alice sent message ${sent.id}`)
  await bob.say({ room: 'lobby', text: 'hey alice' })

  await new Promise((resolve) => setTimeout(resolve, 200))

  alice.close()
  bob.close()
  await srv.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  console.log('done')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
