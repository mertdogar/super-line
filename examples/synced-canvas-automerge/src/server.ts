import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import * as A from '@automerge/automerge'
import { canvas } from './contract.js'
import { fromB64, toB64 } from './b64.js'
import type { Canvas } from './crdt.js'

const PORT = Number(process.env.PORT ?? 8790)
const server = http.createServer()

// In-memory persistence: docId -> Automerge.save() bytes. Swap for a file/DB/Redis to
// survive a restart. The document of record lives HERE, not on any client.
const store = new Map<string, Uint8Array>()
const docs = new Map<string, A.Doc<Canvas>>()

const srv = createSuperLineServer(canvas, {
  transports: [webSocketServerTransport({ server })],
  authenticate: (h) => {
    const name = h.query.name?.trim()
    if (!name) throw new Error('name is required')
    return { role: 'user' as const, ctx: { name } }
  },
})

// The server is the SOLE creator of the canonical doc (`A.from`); clients only ever LOAD
// it. That's what avoids Automerge's "two peers independently `from()` the same shape →
// forked history that won't merge" trap.
function getDoc(docId: string): A.Doc<Canvas> {
  const existing = docs.get(docId)
  if (existing) return existing
  const saved = store.get(docId)
  const doc = saved ? A.load<Canvas>(saved) : A.from<Canvas>({ shapes: {} })
  docs.set(docId, doc)
  return doc
}

// Persist the new doc and fan the change(s) out to the room. Applying a change a peer
// already has is an idempotent no-op, so echoing the sender is harmless.
function commit(docId: string, next: A.Doc<Canvas>, changes: string[], origin: 'peer' | 'server'): void {
  docs.set(docId, next)
  store.set(docId, A.save(next))
  if (changes.length) srv.room(`doc:${docId}`).broadcast('change', { docId, changes, origin })
}

srv.implement({
  user: {
    joinDoc: async ({ docId }, _ctx, conn) => {
      const doc = getDoc(docId)
      srv.room(`doc:${docId}`).add(conn)
      return { snapshot: toB64(A.save(doc)) }
    },
    pushChange: async ({ docId, changes }) => {
      const [next] = A.applyChanges(getDoc(docId), changes.map(fromB64))
      commit(docId, next, changes, 'peer')
      return { ok: true }
    },
    serverNudge: async ({ docId }) => {
      // The server is a co-writer: it edits the canonical doc directly and fans the change
      // out exactly like a client's edit.
      const doc = getDoc(docId)
      const ids = Object.keys(doc.shapes ?? {})
      const id = ids[Math.floor(Math.random() * ids.length)]
      if (!id) return { ok: true }
      const next = A.change(doc, (c) => {
        const s = c.shapes[id]
        if (s) {
          s.x = Math.round(Math.random() * 340)
          s.y = Math.round(Math.random() * 320)
        }
      })
      commit(docId, next, A.getChanges(doc, next).map(toB64), 'server')
      return { ok: true }
    },
  },
})

server.listen(PORT, () => {
  console.log(`synced-canvas (automerge) server on ws://localhost:${PORT}`)
})
