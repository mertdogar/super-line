import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { memoryStoreClient } from '@super-line/store-memory'
import { contract } from './contract.js'

// A writer pinned to node-1 and a reader pinned to node-2 prove cross-node sync: the writer's
// increments travel node-1 → central Postgres → Electric → node-2's local replica → the reader.
const URL = process.env.NODE_URL ?? 'ws://localhost:8801'
const ME = process.env.CLIENT_ID ?? 'client'
const IS_WRITER = process.env.WRITER === '1'

const client = createSuperLineClient(contract, {
  transport: webSocketClientTransport({ url: URL }),
  role: 'user',
  stores: { docs: memoryStoreClient() },
})

// The room is seeded by a node on startup; retry open until it exists (clients can race node startup).
async function openRoom() {
  for (;;) {
    const h = client.store('docs').open('room')
    try {
      await h.ready
      return h
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}

const room = await openRoom()
const count = (): number => (room.getSnapshot() as { count?: number } | undefined)?.count ?? 0
console.log(`${ME} opened room via ${URL}: count=${count()}`)
room.subscribe(() => console.log(`${ME} ← room count=${count()}`))

if (IS_WRITER) {
  setInterval(() => {
    const next = count() + 1
    room.set({ count: next, by: ME })
    console.log(`${ME} → set count=${next}`)
  }, 3000)
}
