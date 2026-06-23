import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { defineContract, SuperLineError } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { memoryStoreClient, memoryStoreServer } from '@super-line/store-memory'
import { webSocketClientTransport, webSocketServerTransport } from '@super-line/transport-websocket'

// A Store is a permissioned, real-time JSON document store. It's off-contract: there's no schema in
// `defineContract` for the document `data` — you pass the backend pair (here the in-memory LWW store)
// to the server and client, and read/write/subscribe methods appear on the instances.
const api = defineContract({ roles: { user: { clientToServer: {} } } })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const code = (e: unknown): string => (e instanceof SuperLineError ? e.code : String(e))

async function main(): Promise<void> {
  const server = http.createServer()
  const srv = createSuperLineServer(api, {
    transports: [webSocketServerTransport({ server })],
    // The ACL principal is the `identify` key (here a uid from the handshake); falls back to conn.id.
    authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid } }),
    identify: (conn) => (conn.ctx as { uid?: string }).uid,
    stores: { docs: memoryStoreServer() },
  })

  await new Promise<void>((resolve) => server.listen(0, resolve))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`

  // Server-authoritative, deny-by-default: the server creates the Resource and grants per principal.
  await srv.store('docs').create(
    'note-1',
    { title: 'Draft', body: '' },
    {
      alice: { read: true, write: true },
      bob: { read: true, write: false }, // bob may read, not write
    },
  )

  const connect = (uid: string) =>
    createSuperLineClient(api, {
      transport: webSocketClientTransport({ url }),
      role: 'user',
      params: { uid },
      stores: { docs: memoryStoreClient() },
    })

  const alice = connect('alice')
  const bob = connect('bob')

  // open() returns a reactive handle: a catch-up snapshot, then live changes.
  const aDoc = alice.store('docs').open('note-1')
  const bDoc = bob.store('docs').open('note-1')
  await Promise.all([aDoc.ready, bDoc.ready])
  console.log('alice opens →', aDoc.getSnapshot())
  console.log('bob opens   →', bDoc.getSnapshot())

  bDoc.subscribe(() => console.log('bob is notified →', bDoc.getSnapshot()))

  // alice writes — it propagates to bob's open handle.
  console.log('\nalice updates the title…')
  aDoc.update({ title: 'Shipping plan' })
  await sleep(100)

  // bob may read but not write → FORBIDDEN.
  console.log('\nbob tries to write…')
  await bob
    .store('docs')
    .write('note-1', { title: 'hijack', body: '' })
    .catch((e) => console.log('  bob denied:', code(e)))

  // carol has no access → can't even open.
  console.log('\ncarol tries to open…')
  const carol = connect('carol')
  await carol
    .store('docs')
    .open('note-1')
    .ready.catch((e) => console.log('  carol denied:', code(e)))

  // the server can grant access and co-write at any time (its writes fan out with a `server` origin).
  console.log('\nserver grants carol read + co-writes…')
  await srv.store('docs').grant('note-1', 'carol', { read: true, write: false })
  await srv.store('docs').write('note-1', { title: 'Shipping plan', body: 'Curated by the server.' })
  await sleep(100)
  console.log('alice final →', aDoc.getSnapshot())

  alice.close()
  bob.close()
  carol.close()
  await srv.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  console.log('\ndone')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
