import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import type { PGliteWithLive } from '@electric-sql/pglite/live'
import { SuperLineError, type DocChange } from '@super-line/core'
import { StoreValue, type StoreMode } from '@super-store/store'
import { crdtPgliteCollections, type CrdtPgliteCollectionsOptions } from '@super-line/collections-crdt-pglite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const PORT = 5602
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean | Promise<boolean>, timeout = 4000): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await sleep(10)
  }
}

const b64 = (u: Uint8Array): string => {
  let s = ''
  for (const byte of u) s += String.fromCharCode(byte)
  return btoa(s)
}
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const docMode = { mode: 'document' as const }

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
// A delta with correct causal context: apply the real central seed, mutate, capture the local update.
function deltaOnSeed(seedB64: string, mutate: (d: StoreValue<Record<string, unknown>, StoreMode>) => void): string {
  const d = new StoreValue<Record<string, unknown>, StoreMode>({}, docMode)
  d.applyUpdate(fromB64(seedB64))
  let delta = ''
  const off = d.onUpdate((u, m) => {
    if (m.local) delta = b64(u)
  })
  mutate(d)
  off()
  d.dispose()
  return delta
}
function decode(stateB64: string): unknown {
  const d = new StoreValue<Record<string, unknown>, StoreMode>({}, docMode)
  d.applyUpdate(fromB64(stateB64))
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
async function makeStore(compact: CrdtPgliteCollectionsOptions['compact'] = false) {
  const table = `crdt_${seq++}`
  const db = (await PGlite.create({ extensions: { live } })) as PGliteWithLive
  // onError silenced: PGLiteSocketServer shares one unnamed prepared statement across connections, so a
  // fire-and-forget append racing an awaited query trips a spurious bind error (real Postgres is per-connection).
  const store = await crdtPgliteCollections({ pgUrl, db, table, docOptions: () => docMode, compact, onError: () => {} }) // no electricUrl: feed driven manually
  cleanups.push(async () => {
    await store.close?.()
    await db.close()
  })
  return { store, db, table, ups: `${table}_updates` }
}
const pass = (): void => {}

describe('collections-crdt-pglite — central CRUD + op-log (postgres.js over pg-wire)', () => {
  it('is self-clustering', async () => {
    const { store } = await makeStore()
    expect(store.clustering).toBe('self')
  })

  it('seeds on create, folds state for read, appends validated deltas on apply', async () => {
    const { store, table } = await makeStore()

    await store.create('scenes', 'a', { count: 1 }, docMode)
    expect(decode((await store.read('scenes', 'a'))!)).toEqual({ count: 1 }) // catch-up folds from the op-log seed

    await expect(store.create('scenes', 'a', { count: 9 }, docMode)).rejects.toMatchObject({ code: 'CONFLICT' })

    // A client delta with a passing validate → apply persists it to the central op-log.
    const { delta } = makeSeedAndDelta({ count: 1 }, (d) => void d.update({ count: 2 }))
    await store.apply({ n: 'scenes', id: 'a', update: delta, origin: 'c1' }, docMode, pass)

    const rows = await host.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}_updates" WHERE collection='scenes' AND res_id='a'`)
    expect(rows.rows[0]?.n).toBe(2) // seed + the delta

    await expect(store.apply({ n: 'scenes', id: 'missing', update: delta, origin: 'x' }, docMode, pass)).rejects.toMatchObject({ code: 'NOT_FOUND' })

    expect((await store.list('scenes')).map((r) => r.id)).toContain('a')

    await store.delete('scenes', 'a')
    expect(await store.read('scenes', 'a')).toBeUndefined()
  })

  it('read returns undefined for an absent document', async () => {
    const { store } = await makeStore()
    expect(await store.read('scenes', 'nope')).toBeUndefined()
  })

  it('keeps documents in different collections separate (same id)', async () => {
    const { store } = await makeStore()
    await store.create('scenes', 'x', { kind: 'scene' }, docMode)
    await store.create('boards', 'x', { kind: 'board' }, docMode)
    expect(decode((await store.read('scenes', 'x'))!)).toEqual({ kind: 'scene' })
    expect(decode((await store.read('boards', 'x'))!)).toEqual({ kind: 'board' })
    await store.delete('scenes', 'x')
    expect(await store.read('scenes', 'x')).toBeUndefined()
    expect(decode((await store.read('boards', 'x'))!)).toEqual({ kind: 'board' }) // sibling collection untouched
  })
})

describe('collections-crdt-pglite — validate-before-commit (the ADR-0007 gate)', () => {
  it('rejects a delta whose post-merge state fails validation, committing nothing', async () => {
    const { store, table } = await makeStore()
    await store.create('scenes', 's1', { title: 'ok' }, docMode)

    // A delta on the REAL seed that would set title to a non-string; the schema guard rejects it.
    const seedRow = await host.query<{ update: string }>(`SELECT update FROM "${table}_updates" WHERE collection='scenes' AND res_id='s1' ORDER BY seq LIMIT 1`)
    const badDelta = deltaOnSeed(seedRow.rows[0]!.update, (d) => void d.set({ title: 42 }))
    const guard = (snap: unknown): void => {
      if (typeof (snap as { title?: unknown }).title !== 'string') throw new SuperLineError('BAD_REQUEST', 'title must be a string')
    }

    await expect(store.apply({ n: 'scenes', id: 's1', update: badDelta, origin: 'c1' }, docMode, guard)).rejects.toThrow(/title must be a string/)

    // Nothing committed: the op-log still holds only the seed, and read() is still the valid state.
    const rows = await host.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}_updates" WHERE collection='scenes' AND res_id='s1'`)
    expect(rows.rows[0]?.n).toBe(1)
    expect(decode((await store.read('scenes', 's1'))!)).toEqual({ title: 'ok' })

    // A valid edit through the same guard commits.
    const okDelta = deltaOnSeed(seedRow.rows[0]!.update, (d) => void d.set({ title: 'edited' }))
    await store.apply({ n: 'scenes', id: 's1', update: okDelta, origin: 'c1' }, docMode, guard)
    const after = await host.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}_updates" WHERE collection='scenes' AND res_id='s1'`)
    expect(after.rows[0]?.n).toBe(2)
  })
})

describe('collections-crdt-pglite — local replica fold (live.changes → onChange/onDelete)', () => {
  it('folds appended deltas into the doc, emits onChange with origin, and onDelete on removal', async () => {
    const { store, db, table, ups } = await makeStore()
    const changes: DocChange[] = []
    const deletes: Array<[string, string]> = []
    store.onChange((c) => changes.push(c))
    store.onDelete?.((n, id) => deletes.push([n, id]))

    const { seed, delta } = makeSeedAndDelta({ count: 1 }, (d) => void d.update({ count: 2 }))

    // Simulate Electric streaming the seed row into this node's local op-log replica.
    await db.query(`INSERT INTO "${ups}" (collection, res_id, update, origin) VALUES ('scenes', 'x', '${seed}', null)`)
    await waitFor(() => changes.some((c) => c.id === 'x'))
    expect(changes.at(-1)).toMatchObject({ n: 'scenes', id: 'x', update: seed })

    await db.query(`INSERT INTO "${ups}" (collection, res_id, update, origin) VALUES ('scenes', 'x', '${delta}', 'c2')`)
    await waitFor(() => changes.some((c) => c.origin === 'c2'))
    expect(changes.at(-1)?.update).toBe(delta)

    // The fold landed in the in-memory doc — observe it through an open() replica snapshot.
    expect(store.open('scenes', 'x').getSnapshot()).toEqual({ count: 2 })

    // A meta row (existence) drives the DELETE feed; insert then delete it → onDelete(collection, id).
    await db.query(`INSERT INTO "${table}" (collection, id, origin) VALUES ('scenes', 'x', null)`)
    await db.query(`DELETE FROM "${table}" WHERE collection = 'scenes' AND id = 'x'`)
    await waitFor(() => deletes.some(([n, id]) => n === 'scenes' && id === 'x'))
  })
})

describe('collections-crdt-pglite — open()/CrdtServerReplica (the agent co-writer)', () => {
  it('reads the live doc synchronously and writes merge deltas through to the op-log', async () => {
    const { store } = await makeStore()
    await store.create('scenes', 'board', { shapes: {} }, docMode)

    const replica = store.open('scenes', 'board', { origin: 'agent:1' })

    replica.update({ shapes: { S1: { x: 10, y: 20 } } })
    expect(replica.getSnapshot()).toEqual({ shapes: { S1: { x: 10, y: 20 } } })

    replica.update({ shapes: { S2: { x: 1, y: 2 } } })
    expect(replica.getSnapshot()).toEqual({ shapes: { S1: { x: 10, y: 20 }, S2: { x: 1, y: 2 } } })

    // delete(path) is the only key-removing surface — drops S1 without clobbering S2 (CRDT merge).
    replica.delete(['shapes', 'S1'])
    expect(replica.getSnapshot()).toEqual({ shapes: { S2: { x: 1, y: 2 } } })

    // Each write was appended to the central op-log (seed + 3 writes); a fresh fold reconstructs the state.
    await waitFor(async () => {
      const folded = decode((await store.read('scenes', 'board'))!) as { shapes: Record<string, unknown> }
      return JSON.stringify(folded) === JSON.stringify({ shapes: { S2: { x: 1, y: 2 } } })
    })

    replica.close()
    // a non-existent doc still opens (empty doc) — the agent's turn may run before catch-up.
    expect(store.open('scenes', 'ghost').getSnapshot()).toEqual({})
  })
})

describe('collections-crdt-pglite — fold robustness', () => {
  it('skips a poison op-log row without wedging the feed', async () => {
    const { store, db, ups } = await makeStore()
    const changes: DocChange[] = []
    store.onChange((c) => changes.push(c))
    const { seed } = makeSeedAndDelta({ ok: 1 }, () => {})

    await db.query(`INSERT INTO "${ups}" (collection, res_id, update, origin) VALUES ('scenes', 'p', '%%%not-base64%%%', 'bad')`)
    await db.query(`INSERT INTO "${ups}" (collection, res_id, update, origin) VALUES ('scenes', 'p', '${seed}', 'good')`)

    await waitFor(() => changes.some((c) => c.origin === 'good'))
    expect(store.open('scenes', 'p').getSnapshot()).toEqual({ ok: 1 })
  })
})

describe('collections-crdt-pglite — compaction + materialized snapshot', () => {
  it('folds the op-log into <table>.data and trims to a baseline', async () => {
    const { store, db, table, ups } = await makeStore({ everyNUpdates: 100, debounceMs: 60 })
    await store.create('scenes', 'c', { v: 0 }, docMode)

    // Build coherent deltas on the actual seed (v:0 → 1 → 2 → 3 → 4), feeding each to BOTH central and the local
    // replica (a write + its Electric echo) — the local fold is what schedules the debounced compaction.
    const seedRow = await host.query<{ update: string }>(`SELECT update FROM "${ups}" WHERE collection='scenes' AND res_id='c' ORDER BY seq LIMIT 1`)
    const cl = new StoreValue<Record<string, unknown>, StoreMode>({}, docMode)
    cl.applyUpdate(fromB64(seedRow.rows[0]!.update))
    let cur = ''
    const off = cl.onUpdate((u, m) => {
      if (m.local) cur = b64(u)
    })
    for (let v = 1; v <= 4; v++) {
      cl.update({ v })
      await host.query(`INSERT INTO "${ups}" (collection, res_id, update, origin) VALUES ('scenes', 'c', '${cur}', 'w')`)
      await db.query(`INSERT INTO "${ups}" (collection, res_id, update, origin) VALUES ('scenes', 'c', '${cur}', 'w')`)
    }
    off()

    // compaction materializes <table>.data = the folded board (SQL-queryable, no fold needed).
    await waitFor(async () => {
      const r = await host.query<{ data: unknown }>(`SELECT data FROM "${table}" WHERE collection='scenes' AND id='c'`)
      return JSON.stringify(r.rows[0]?.data) === JSON.stringify({ v: 4 })
    })

    // and the op-log was trimmed to a baseline (was seed + 4 = 5 rows) that still folds to the same state.
    const rows = await host.query<{ update: string }>(`SELECT update FROM "${ups}" WHERE collection='scenes' AND res_id='c' ORDER BY seq`)
    expect(rows.rows.length).toBeLessThan(5)
    const fold = new StoreValue<Record<string, unknown>, StoreMode>({}, docMode)
    for (const r of rows.rows) fold.applyUpdate(fromB64(r.update))
    expect(fold.getSnapshot()).toEqual({ v: 4 })
  })
})
