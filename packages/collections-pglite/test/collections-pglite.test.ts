import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import type { PGliteWithLive } from '@electric-sql/pglite/live'
import { z } from 'zod'
import type { CollectionDef, CollectionStore, RowChange } from '@super-line/core'
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

const defs: Record<string, CollectionDef> = {
  messages: { schema: z.object({ id: z.string(), channelId: z.string(), text: z.string(), likes: z.number() }), key: 'id' },
  users: { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' },
  feeds: { schema: z.object({ id: z.string(), v: z.number(), tag: z.string().optional() }), key: 'id' },
  // camelCase primary key — Electric folds the raw key identifier in its live.changes diff JOINs, so this
  // table's feed must alias the key to a folded-safe name or the backend crashes on boot (regression below).
  presence: { schema: z.object({ userId: z.string(), online: z.boolean() }), key: 'userId' },
}

const pgUrl = `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

let seq = 0
async function makeStore() {
  const tablePrefix = `c${seq++}_`
  const db = (await PGlite.create({ extensions: { live } })) as PGliteWithLive
  const store = await pgliteCollections({ pgUrl, db, collections: defs, tablePrefix }) // no electricUrl: feed driven manually
  cleanups.push(async () => {
    await store.close?.()
    await db.close()
  })
  return { store, db, tablePrefix }
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
  it('maps a streamed insert/update/delete to onChange over the typed table', async () => {
    const { store, db, tablePrefix } = await makeStore()
    const t = `${tablePrefix}feeds`
    const seen: RowChange[] = []
    store.onChange((c) => seen.push(c))

    // Simulate Electric streaming an INSERT into this node's local replica.
    await db.query(`INSERT INTO "${t}" ("id", "v", "tag", "_sl_origin") VALUES ('x', 9, 'a', 'c1')`)
    await waitFor(() => seen.some((c) => c.k === 'insert' && c.id === 'x'))
    const ins = seen.find((c) => c.k === 'insert')
    expect(ins).toMatchObject({ n: 'feeds', id: 'x', origin: 'c1' })
    expect(ins?.next).toEqual({ id: 'x', v: 9, tag: 'a' })

    // THE partial-diff pin: live.changes carries only CHANGED columns on UPDATE. Touching just "v" must
    // still surface a COMPLETE row (re-read from the replica) — routing and TanStack need whole rows.
    await db.query(`UPDATE "${t}" SET "v" = 10, "_sl_origin" = 'c2' WHERE "id" = 'x'`)
    await waitFor(() => seen.some((c) => c.k === 'update' && c.id === 'x'))
    const upd = seen.find((c) => c.k === 'update')
    expect(upd).toMatchObject({ n: 'feeds', id: 'x', origin: 'c2' })
    expect(upd?.next).toEqual({ id: 'x', v: 10, tag: 'a' }) // tag unchanged yet present

    // DELETE → no columns carried; collection+id come from the table's own key.
    await db.query(`DELETE FROM "${t}" WHERE "id" = 'x'`)
    await waitFor(() => seen.some((c) => c.k === 'delete' && c.id === 'x'))
    expect(seen.find((c) => c.k === 'delete')).toMatchObject({ n: 'feeds', id: 'x' })
  })

  // Regression: a camelCase key (e.g. plugin-auth's userPresence keyed on `userId`) once crashed the backend on
  // boot — Electric interpolates the key raw into its live-query diff JOINs, folding `userId` → `userid`. The feed
  // aliases the key to a folded-safe sentinel so the whole insert/update/delete cycle still surfaces.
  it('streams a camelCase-keyed collection through the feed', async () => {
    const { store, db, tablePrefix } = await makeStore()
    const t = `${tablePrefix}presence`
    const seen: RowChange[] = []
    store.onChange((c) => seen.push(c))

    await db.query(`INSERT INTO "${t}" ("userId", "online", "_sl_origin") VALUES ('u1', true, 'c1')`)
    await waitFor(() => seen.some((c) => c.k === 'insert' && c.id === 'u1'))
    expect(seen.find((c) => c.k === 'insert')).toMatchObject({ n: 'presence', id: 'u1', origin: 'c1' })
    expect(seen.find((c) => c.k === 'insert')?.next).toEqual({ userId: 'u1', online: true })

    await db.query(`UPDATE "${t}" SET "online" = false, "_sl_origin" = 'c2' WHERE "userId" = 'u1'`)
    await waitFor(() => seen.some((c) => c.k === 'update' && c.id === 'u1'))
    expect(seen.find((c) => c.k === 'update')?.next).toEqual({ userId: 'u1', online: false })

    await db.query(`DELETE FROM "${t}" WHERE "userId" = 'u1'`)
    await waitFor(() => seen.some((c) => c.k === 'delete' && c.id === 'u1'))
    expect(seen.find((c) => c.k === 'delete')).toMatchObject({ n: 'presence', id: 'u1' })
  })
})
