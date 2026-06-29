import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import type { PGliteWithLive } from '@electric-sql/pglite/live'
import type { StoreChange } from '@super-line/core'
import { StoreValue, type StoreMode } from '@super-store/store'
import { syncPgliteStoreServer, type DocOptions, type SyncPgliteStoreOptions } from '@super-line/store-sync-pglite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const PORT = 5601
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean | Promise<boolean>, timeout = 4000): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await sleep(10)
  }
}

// base64 <-> Yjs update, mirroring the store/client wire encoding.
const b64 = (u: Uint8Array): string => {
  let s = ''
  for (const byte of u) s += String.fromCharCode(byte)
  return btoa(s)
}
const docMode: DocOptions = { mode: 'document' }
// Build a base64 catch-up state for `value`, plus a follow-up local delta produced by applying `mutate`.
function makeSeedAndDelta(value: Record<string, unknown>, mutate: (d: StoreValue<Record<string, unknown>, StoreMode>) => void) {
  const d = new StoreValue<Record<string, unknown>, StoreMode>(value, docMode)
  const seed = b64(d.encodeState())
  let delta = ''
  const off = d.onUpdate((u, m) => {
    if (m.local) delta = b64(u)
  })
  mutate(d)
  off()
  return { seed, delta }
}
function decode(stateB64: string): unknown {
  const d = new StoreValue<Record<string, unknown>, StoreMode>({}, docMode)
  d.applyUpdate(Uint8Array.from(atob(stateB64), (c) => c.charCodeAt(0)))
  return d.getSnapshot()
}

// One PGLiteSocketServer is the "central Postgres" (pg-wire) for the whole file.
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
async function makeStore(compact: SyncPgliteStoreOptions['compact'] = false) {
  const table = `res_${seq++}`
  const db = (await PGlite.create({ extensions: { live } })) as PGliteWithLive
  // onError silenced: PGLiteSocketServer shares one unnamed prepared statement across connections, so a
  // fire-and-forget append racing an awaited query trips a spurious bind error here (real Postgres is per-
  // connection — verified persisting in Docker). The awaited apply + compaction tests cover real persistence.
  const store = await syncPgliteStoreServer({ pgUrl, db, table, resolveOptions: () => docMode, compact, onError: () => {} }) // no electricUrl: feed driven manually
  cleanups.push(async () => {
    await store.close?.()
    await db.close()
  })
  return { store, db, table, ups: `${table}_updates` }
}

describe('store-sync-pglite — central CRUD + op-log (postgres.js over pg-wire)', () => {
  it('is self-clustering and CRDT', async () => {
    const { store } = await makeStore()
    expect(store.clustering).toBe('self')
    expect(store.model).toBe('crdt')
  })

  it('seeds on create, folds state for read, appends deltas on apply', async () => {
    const { store, table } = await makeStore()

    await store.create('a', { count: 1 }, { alice: { read: true, write: true } })
    const r = await store.read('a')
    expect(r?.accessRules).toEqual({ alice: { read: true, write: true } })
    expect(decode(r!.data as string)).toEqual({ count: 1 }) // catch-up state folds from the op-log seed

    await expect(store.create('a', { count: 9 }, {})).rejects.toMatchObject({ code: 'CONFLICT' })

    // A client delta { count: 1 } → { count: 2 }. apply persists it to the central op-log.
    const { delta } = makeSeedAndDelta({ count: 1 }, (d) => void d.update({ count: 2 }))
    await store.apply({ id: 'a', update: delta, origin: 'c1' })

    // central op-log now has the seed + the delta for 'a' (host = the central Postgres behind the socket)
    const rows = await host.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}_updates" WHERE res_id = 'a'`)
    expect(rows.rows[0]?.n).toBe(2)

    await expect(store.apply({ id: 'missing', update: delta, origin: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await store.setAccess('a', { bob: { read: true, write: false } })
    expect((await store.read('a'))?.accessRules).toEqual({ bob: { read: true, write: false } })

    expect(await store.list()).toContain('a')

    await store.delete('a')
    expect(await store.read('a')).toBeUndefined()
  })

  it('read returns undefined for an absent resource', async () => {
    const { store } = await makeStore()
    expect(await store.read('nope')).toBeUndefined()
  })
})

describe('store-sync-pglite — local replica fold (live.changes → onChange/onDelete)', () => {
  it('folds appended deltas into the doc, emits onChange with origin, and onDelete on resource removal', async () => {
    const { store, db, table, ups } = await makeStore()
    const changes: StoreChange[] = []
    const deletes: string[] = []
    store.onChange((c) => changes.push(c))
    store.onDelete?.((id) => deletes.push(id))

    const { seed, delta } = makeSeedAndDelta({ count: 1 }, (d) => void d.update({ count: 2 }))

    // Simulate Electric streaming the seed row into this node's local op-log replica.
    await db.query(`INSERT INTO "${ups}" (res_id, update, origin) VALUES ('x', '${seed}', null)`)
    await waitFor(() => changes.some((c) => c.id === 'x'))
    expect(changes.at(-1)?.update).toBe(seed)

    // A follow-up delta row → onChange carrying the delta + its origin; the doc folds to { count: 2 }.
    await db.query(`INSERT INTO "${ups}" (res_id, update, origin) VALUES ('x', '${delta}', 'c2')`)
    await waitFor(() => changes.some((c) => c.origin === 'c2'))
    expect(changes.at(-1)?.update).toBe(delta)

    // The fold landed in the store's in-memory doc — observe it through a ServerReplica snapshot.
    expect(store.open?.('x').getSnapshot()).toEqual({ count: 2 })

    // A meta row (existence) is needed for the DELETE feed; insert then delete it.
    await db.query(`INSERT INTO "${table}" (id, access, origin) VALUES ('x', '{}'::jsonb, null)`)
    await db.query(`DELETE FROM "${table}" WHERE id = 'x'`)
    await waitFor(() => deletes.includes('x'))
  })
})

describe('store-sync-pglite — open()/ServerReplica (the agent co-writer)', () => {
  it('reads the live doc synchronously and writes merge deltas through to the op-log', async () => {
    const { store } = await makeStore()
    await store.create('board', { shapes: {} }, { agent: { read: true, write: true } })

    const replica = store.open!('board', { origin: 'agent:1' })

    // Sync getSnapshot reflects the agent's own writes immediately (no async driver in the read path).
    replica.update({ shapes: { S1: { x: 10, y: 20 } } })
    expect(replica.getSnapshot()).toEqual({ shapes: { S1: { x: 10, y: 20 } } })

    replica.update({ shapes: { S2: { x: 1, y: 2 } } })
    expect(replica.getSnapshot()).toEqual({ shapes: { S1: { x: 10, y: 20 }, S2: { x: 1, y: 2 } } })

    // delete(path) is the only key-removing surface — it drops S1 without clobbering S2 (CRDT merge).
    replica.delete(['shapes', 'S1'])
    expect(replica.getSnapshot()).toEqual({ shapes: { S2: { x: 1, y: 2 } } })

    // Each write was appended to the central op-log (seed + 3 writes); a fresh fold reconstructs the state.
    await waitFor(async () => {
      const folded = decode((await store.read('board'))!.data as string) as { shapes: Record<string, unknown> }
      return JSON.stringify(folded) === JSON.stringify({ shapes: { S2: { x: 1, y: 2 } } })
    })

    replica.close()
    // ponytail: a non-existent resource still opens (empty doc); the agent's turn runs well after seed/sync.
    expect(store.open!('ghost').getSnapshot()).toEqual({})
  })
})

describe('store-sync-pglite — apply() object co-write (server merge)', () => {
  it('merges an object update into an existing resource and rejects a missing one', async () => {
    const { store } = await makeStore()
    await store.create('o', { a: 1 }, { s: { read: true, write: true } })

    // an object (not base64) update = a server co-write: merge top-level keys into the live doc.
    await store.apply({ id: 'o', update: { b: 2 }, origin: 'server' })
    expect(decode((await store.read('o'))!.data as string)).toEqual({ a: 1, b: 2 })

    // a write to a missing/deleted id → NOT_FOUND (parity with the string path + both store siblings), not an orphan.
    await expect(store.apply({ id: 'missing', update: { x: 1 }, origin: 'server' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('store-sync-pglite — fold robustness', () => {
  it('skips a poison op-log row without wedging the feed', async () => {
    const { store, db, ups } = await makeStore()
    const changes: StoreChange[] = []
    store.onChange((c) => changes.push(c))
    const { seed } = makeSeedAndDelta({ ok: 1 }, () => {})

    // an un-decodable row (invalid base64 → fromB64 throws), then a valid one — the valid one must still fold.
    await db.query(`INSERT INTO "${ups}" (res_id, update, origin) VALUES ('p', '%%%not-base64%%%', 'bad')`)
    await db.query(`INSERT INTO "${ups}" (res_id, update, origin) VALUES ('p', '${seed}', 'good')`)

    await waitFor(() => changes.some((c) => c.origin === 'good'))
    expect(store.open?.('p').getSnapshot()).toEqual({ ok: 1 })
  })
})

describe('store-sync-pglite — compaction + materialized snapshot', () => {
  it('folds the op-log into <table>.data and trims to a baseline', async () => {
    const { store, db, table, ups } = await makeStore({ everyNUpdates: 100, debounceMs: 60 })
    await store.create('c', { v: 0 }, { a: { read: true, write: true } })

    // build coherent deltas on the actual seed (v:0 → 1 → 2 → 3 → 4), feeding each to BOTH central (host) and the
    // local replica (a write + its Electric echo) — the local fold is what schedules the debounced compaction.
    const seedRow = await host.query<{ update: string }>(`SELECT update FROM "${ups}" WHERE res_id='c' ORDER BY seq LIMIT 1`)
    const cl = new StoreValue<Record<string, unknown>, StoreMode>({}, docMode)
    cl.applyUpdate(Uint8Array.from(atob(seedRow.rows[0]!.update), (ch) => ch.charCodeAt(0)))
    let cur = ''
    const off = cl.onUpdate((u, m) => {
      if (m.local) cur = b64(u)
    })
    for (let v = 1; v <= 4; v++) {
      cl.update({ v })
      await host.query(`INSERT INTO "${ups}" (res_id, update, origin) VALUES ('c', '${cur}', 'w')`)
      await db.query(`INSERT INTO "${ups}" (res_id, update, origin) VALUES ('c', '${cur}', 'w')`)
    }
    off()

    // compaction materializes <table>.data = the folded board (SQL-queryable, no fold needed).
    await waitFor(async () => {
      const r = await host.query<{ data: unknown }>(`SELECT data FROM "${table}" WHERE id='c'`)
      return JSON.stringify(r.rows[0]?.data) === JSON.stringify({ v: 4 })
    })

    // and the op-log was trimmed to a baseline (was seed + 4 = 5 rows) that still folds to the same state.
    const rows = await host.query<{ update: string }>(`SELECT update FROM "${ups}" WHERE res_id='c' ORDER BY seq`)
    expect(rows.rows.length).toBeLessThan(5)
    const fold = new StoreValue<Record<string, unknown>, StoreMode>({}, docMode)
    for (const r of rows.rows) fold.applyUpdate(Uint8Array.from(atob(r.update), (ch) => ch.charCodeAt(0)))
    expect(fold.getSnapshot()).toEqual({ v: 4 })
  })
})
