import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { syncStoreServer } from '@super-line/store-sync'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { api } from './contract.js'

const PORT = Number(process.env.PORT ?? 8795)
const DOC = 'plan' // the one shared Resource everybody edits
const server = http.createServer()

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  // the handshake `name` becomes the ACL principal (stable across reconnects)
  authenticate: (h) => {
    const name = h.query.name?.trim()
    if (!name) throw new Error('name is required')
    return { role: 'user' as const, ctx: { name } }
  },
  identify: (conn) => (conn.ctx as { name: string }).name,
  // the CRDT Store — swap syncStoreServer() for memoryStoreServer() to get last-writer-wins instead
  stores: { docs: syncStoreServer() },
  // open join: deny-by-default, so grant every connection read+write on the shared doc as it arrives
  onConnection: (conn) => {
    const principal = conn.principal ?? conn.id
    void srv.store('docs').grant(DOC, principal, { read: true, write: true })
  },
})

// Seed the canonical document once, before anyone connects (server-authoritative create).
await srv.store('docs').create(
  DOC,
  {
    title: 'Launch plan',
    status: 'in-progress',
    priority: 3,
    done: false,
    tags: ['q3', 'marketing'],
    owner: { name: 'Ada', email: 'ada@example.com' },
  },
  {},
)

srv.implement({
  user: {
    // The server is a co-writer: it MERGES a field into the doc, fanned to every tab with origin 'server'.
    nudge: async () => {
      await srv.store('docs').write(DOC, { priority: Math.floor(Math.random() * 5) + 1 })
      return { ok: true }
    },
  },
})

server.listen(PORT, () => {
  console.log(`store-sync-json server on ws://localhost:${PORT}`)
})
