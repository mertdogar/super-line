import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { crdtMemoryCollections } from '@super-line/collections-crdt-memory'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { api } from './contract.js'

const PORT = Number(process.env.PORT ?? 8795)
const DOC = 'plan' // the one shared document everybody edits
const server = http.createServer()

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  // the handshake `name` becomes the principal (stable across reconnects), used by the row policies
  authenticate: (h) => {
    const name = h.query.name?.trim()
    if (!name) throw new Error('name is required')
    return { role: 'user' as const, ctx: { name } }
  },
  identify: (conn) => (conn.ctx as { name: string }).name,
  // the CRDT document collection — merging docs, opened by id, validated on every write
  crdtCollections: crdtMemoryCollections(),
  // deny-by-default guards; this open demo lets every connection read + write the shared doc
  policies: { docs: { read: () => true, write: () => true } },
})

// Seed the canonical document once, before anyone connects (server-authoritative create).
await srv.collection('docs').create(DOC, {
  title: 'Launch plan',
  status: 'in-progress',
  priority: 3,
  done: false,
  tags: ['q3', 'marketing'],
  owner: { name: 'Ada', email: 'ada@example.com' },
})

srv.implement({
  user: {
    // The server is a co-writer: open the canonical doc and MERGE a field, fanned to every tab with origin 'server'.
    nudge: async () => {
      const doc = srv.collection('docs').open(DOC, { origin: 'server' })
      doc.update({ priority: Math.floor(Math.random() * 5) + 1 })
      doc.close()
      return { ok: true }
    },
  },
})

server.listen(PORT, () => {
  console.log(`store-sync-json server on ws://localhost:${PORT}`)
})
