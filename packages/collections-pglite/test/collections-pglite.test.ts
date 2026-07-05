import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import type { PGliteWithLive } from '@electric-sql/pglite/live'
import { eq } from '@super-line/core'
import type { RowChange } from '@super-line/core'
import { pgliteCollections } from '@super-line/collections-pglite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

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

const msg = (id: string, channelId: string, n: number) => ({ id, channelId, text: `m${n}`, likes: n })

describe('pglite collections — central CRUD (postgres.js over pg-wire)', () => {
  it('is self-clustering', async () => {
    const { store } = await makeStore()
    expect(store.clustering).toBe('self')
  })

  it('round-trips insert/update/delete across collections with strong central reads', async () => {
    const { store } = await makeStore()
    await store.apply([{ op: 'insert', n: 'users', id: 'u1', row: { id: 'u1', name: 'Ada' } }], 'o1')
    await store.apply([{ op: 'insert', n: 'messages', id: 'm1', row: msg('m1', 'general', 1) }], 'o1')
    expect(await store.read('users', 'u1')).toEqual({ id: 'u1', name: 'Ada' })
    expect(await store.read('messages', 'm1')).toEqual(msg('m1', 'general', 1))
    // same id in different collections is distinct (composite key)
    expect(await store.read('users', 'm1')).toBeUndefined()

    await expect(store.apply([{ op: 'insert', n: 'messages', id: 'm1', row: msg('m1', 'general', 2) }], 'o1')).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(store.apply([{ op: 'update', n: 'messages', id: 'zz', row: msg('zz', 'general', 1) }], 'o1')).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await store.apply([{ op: 'update', n: 'messages', id: 'm1', row: msg('m1', 'general', 9) }], 'o1')
    expect(await store.read('messages', 'm1')).toEqual(msg('m1', 'general', 9))

    await store.apply([{ op: 'delete', n: 'messages', id: 'm1' }], 'o1')
    expect(await store.read('messages', 'm1')).toBeUndefined()
  })

  it('applies a batch atomically (a failing op rolls the whole transaction back)', async () => {
    const { store } = await makeStore()
    await store.apply([{ op: 'insert', n: 'messages', id: 'a', row: msg('a', 'g', 1) }], 'o')
    await expect(
      store.apply(
        [
          { op: 'insert', n: 'messages', id: 'b', row: msg('b', 'g', 2) },
          { op: 'insert', n: 'messages', id: 'a', row: msg('a', 'g', 3) }, // duplicate → whole batch rolls back
        ],
        'o',
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await store.read('messages', 'b')).toBeUndefined()
  })

  it('snapshots with the query IR (filter + sort + limit), scoped to the collection', async () => {
    const { store } = await makeStore()
    await store.apply(
      [
        { op: 'insert', n: 'messages', id: 'a', row: msg('a', 'general', 3) },
        { op: 'insert', n: 'messages', id: 'b', row: msg('b', 'random', 1) },
        { op: 'insert', n: 'messages', id: 'c', row: msg('c', 'general', 5) },
        { op: 'insert', n: 'users', id: 'u1', row: { id: 'u1', name: 'Ada' } },
      ],
      'o',
    )
    const out = (await store.snapshot('messages', { filter: eq('channelId', 'general'), orderBy: [{ field: 'likes', dir: 'desc' }], limit: 1 })) as ReturnType<typeof msg>[]
    expect(out.map((r) => r.id)).toEqual(['c'])
    expect((await store.snapshot('users', {})).length).toBe(1) // scoped: only the users collection
  })
})

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
