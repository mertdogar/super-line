import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import * as Y from 'yjs'
import { canvas } from './contract.js'
import { fromB64, toB64 } from './b64.js'

const PORT = Number(process.env.PORT ?? 8788)
const server = http.createServer()

// In-memory persistence: docId -> encoded Yjs state. This is the only "store" in the
// demo; swap it for a file / DB / Redis to survive a restart. Server-side persistence
// is core to the design — the document of record lives HERE, not on any client.
const store = new Map<string, Uint8Array>()
const docs = new Map<string, Y.Doc>()

const srv = createSuperLineServer(canvas, {
  transports: [webSocketServerTransport({ server })],
  authenticate: (h) => {
    const name = h.query.name?.trim()
    if (!name) throw new Error('name is required')
    return { role: 'user' as const, ctx: { name } }
  },
})

// Materialise the canonical doc for a room and hydrate it from the store. The doc's own
// update observer is the single fan-out + persist point — it fires for BOTH client-pushed
// merges and the server's own (co-writer) edits, so there's exactly one path out.
function getDoc(docId: string): Y.Doc {
  const existing = docs.get(docId)
  if (existing) return existing
  const doc = new Y.Doc()
  const saved = store.get(docId)
  if (saved) Y.applyUpdate(doc, saved)
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    store.set(docId, Y.encodeStateAsUpdate(doc))
    // serverNudge transacts with origin 'server'; client merges arrive with origin 'client'.
    const from = origin === 'server' ? 'server' : 'peer'
    srv.room(`doc:${docId}`).broadcast('update', { docId, update: toB64(update), origin: from })
  })
  docs.set(docId, doc)
  return doc
}

srv.implement({
  user: {
    joinDoc: async ({ docId }, _ctx, conn) => {
      const doc = getDoc(docId)
      srv.room(`doc:${docId}`).add(conn)
      return { snapshot: toB64(Y.encodeStateAsUpdate(doc)) }
    },
    pushUpdate: async ({ docId, update }) => {
      // Applying an update the doc already has is an idempotent no-op (CRDT), so echoing
      // a client's own update back to it is harmless — no special-casing needed.
      Y.applyUpdate(getDoc(docId), fromB64(update), 'client')
      return { ok: true }
    },
    serverNudge: async ({ docId }) => {
      // The server is a co-writer: it mutates the canonical doc directly, and the observer
      // above broadcasts it to every client exactly like another user's edit.
      const doc = getDoc(docId)
      const shapes = doc.getMap<Y.Map<unknown>>('shapes')
      const ids = [...shapes.keys()]
      const id = ids[Math.floor(Math.random() * ids.length)]
      const shape = id ? shapes.get(id) : undefined
      if (shape) {
        doc.transact(() => {
          shape.set('x', Math.round(Math.random() * 340))
          shape.set('y', Math.round(Math.random() * 320))
        }, 'server')
      }
      return { ok: true }
    },
  },
})

server.listen(PORT, () => {
  console.log(`synced-canvas (yjs) server on ws://localhost:${PORT}`)
})
