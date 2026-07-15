import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import type { PGliteWithLive } from '@electric-sql/pglite/live'
import type { CollectionStore, RowChange } from '@super-line/core'
import { pgliteCollections } from '@super-line/collections-pglite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runRowConformance } from '../../core/test/collection-store-conformance.js'

const PORT = 5601
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeout = 4000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await sleep(10)
  }
}

// One PGLiteSocketServer is the "central Postgres" (pg-wire) for the whole file — no Docker/Electric.
let host: PGlite
let server: PGLiteSocketServer
beforeAll(async () => {
  host = await PGlite.create()
  server = new PGLiteSocketServer({ db: host, port: PORT, host: '127.0.0.1', maxConnections: 30 })
  await server.start()
})
afterAll(async () => {
  await server.stop()
  await host.close()
})

const pgUrl = `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

let seq = 0
async function makeStore() {
  const table = `coll_${seq++}`
  const db = (await PGlite.create({ extensions: { live } })) as PGliteWithLive
  const store = await pgliteCollections({ pgUrl, db, table }) // no electricUrl: feed driven manually
  cleanups.push(async () => {
    await store.close?.()
    await db.close()
  })
  return { store, db, table }
}

// The seam's contract, asserted once for every backend. `self` gates off the relay clauses: this backend's
// `apply` deliberately does NOT fire onChange (its replication feed does, on every node — see below) and
// returns nothing, so those clauses would be asserting a contract it is right not to honour.
runRowConformance('collections-pglite', {
  make: async (): Promise<CollectionStore> => (await makeStore()).store,
  clustering: 'self',
})

// Below: only what is genuinely pglite's — the half of `apply`'s contract that the suite cannot cover,
// because for a `self` backend the change surfaces through the replica feed rather than from `apply`.
describe('pglite collections — local replica feed (live.changes → onChange)', () => {
  it('maps a streamed insert/update/delete to onChange, parsing collection+id on delete', async () => {
    const { store, db, table } = await makeStore()
    const seen: RowChange[] = []
    store.onChange((c) => seen.push(c))
    const PK = `'messages' || chr(1) || 'x'` // synthetic key built server-side

    // Simulate Electric streaming an INSERT into this node's local replica.
    await db.query(`INSERT INTO "${table}" (pk, collection, id, data, origin) VALUES (${PK}, 'messages', 'x', '{"id":"x","v":9}'::jsonb, 'c1')`)
    await waitFor(() => seen.some((c) => c.k === 'insert' && c.id === 'x'))
    const ins = seen.find((c) => c.k === 'insert')
    expect(ins).toMatchObject({ n: 'messages', id: 'x', origin: 'c1' })
    expect(ins?.next).toEqual({ id: 'x', v: 9 })

    await db.query(`UPDATE "${table}" SET data = '{"id":"x","v":10}'::jsonb, origin = 'c2' WHERE pk = ${PK}`)
    await waitFor(() => seen.some((c) => c.k === 'update' && c.id === 'x'))

    // DELETE → the row's data isn't carried; collection+id come from the key.
    await db.query(`DELETE FROM "${table}" WHERE pk = ${PK}`)
    await waitFor(() => seen.some((c) => c.k === 'delete' && c.id === 'x'))
    expect(seen.find((c) => c.k === 'delete')).toMatchObject({ n: 'messages', id: 'x' })
  })
})
