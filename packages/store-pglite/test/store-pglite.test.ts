import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import type { PGliteWithLive } from '@electric-sql/pglite/live'
import type { StoreChange } from '@super-line/core'
import { pgliteStoreServer } from '@super-line/store-pglite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const PORT = 5599
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeout = 4000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await sleep(10)
  }
}

// One PGLiteSocketServer acts as the "central Postgres" (pg-wire) for the whole file.
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
  const table = `res_${seq++}`
  const db = (await PGlite.create({ extensions: { live } })) as PGliteWithLive
  const store = await pgliteStoreServer({ pgUrl, db, table }) // no electricUrl: feed driven manually
  cleanups.push(async () => {
    await store.close?.()
    await db.close()
  })
  return { store, db, table }
}

describe('pglite store — central CRUD (postgres.js over pg-wire)', () => {
  it('round-trips create/read/apply/setAccess/list/delete', async () => {
    const { store } = await makeStore()

    await store.create('a', { v: 1 }, { alice: { read: true, write: true } })
    expect((await store.read('a'))?.data).toEqual({ v: 1 })
    expect((await store.read('a'))?.accessRules).toEqual({ alice: { read: true, write: true } })

    await expect(store.create('a', { v: 2 }, {})).rejects.toMatchObject({ code: 'CONFLICT' })

    await store.apply({ id: 'a', update: { v: 2 }, origin: 'c1' })
    expect((await store.read('a'))?.data).toEqual({ v: 2 })

    await expect(store.apply({ id: 'missing', update: {}, origin: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await store.setAccess('a', { bob: { read: true, write: false } })
    expect((await store.read('a'))?.accessRules).toEqual({ bob: { read: true, write: false } })

    expect((await store.list()).map((r) => r.id)).toContain('a')

    await store.delete('a')
    expect(await store.read('a')).toBeUndefined()
  })

  it('read returns undefined for an absent resource', async () => {
    const { store } = await makeStore()
    expect(await store.read('nope')).toBeUndefined()
  })

  it('is self-clustering and last-writer-wins', async () => {
    const { store } = await makeStore()
    expect(store.clustering).toBe('self')
    expect(store.model).toBe('lww')
  })
})

describe('pglite store — list()/searchPrincipals (central ACL index + timestamps)', () => {
  it('filters, sorts, paginates + maintains the ACL index and timestamps', async () => {
    const { store } = await makeStore()
    await store.create('chan-a', { v: 1 }, { alice: { read: true, write: true }, bob: { read: true, write: false } })
    await store.create('chan-b', { v: 1 }, { bob: { read: true, write: true } })
    await store.create('room-x', { v: 1 }, { carol: { read: true, write: true } })

    // default: every row, id ASC, with principalCount + timestamps
    const all = await store.list()
    expect(all.map((r) => r.id)).toEqual(['chan-a', 'chan-b', 'room-x'])
    const a = all.find((r) => r.id === 'chan-a')!
    expect(a.principalCount).toBe(2)
    expect(a.createdAt).toBeGreaterThan(0)
    expect(a.updatedAt).toBe(a.createdAt)

    // idContains = substring
    expect((await store.list({ idContains: 'chan' })).map((r) => r.id)).toEqual(['chan-a', 'chan-b'])

    // principals = union/OR
    expect((await store.list({ principals: ['bob'] })).map((r) => r.id).sort()).toEqual(['chan-a', 'chan-b'])
    expect((await store.list({ principals: ['alice', 'carol'] })).map((r) => r.id).sort()).toEqual(['chan-a', 'room-x'])

    // sort + paginate
    expect((await store.list({ sort: { by: 'id', dir: 'desc' } })).map((r) => r.id)).toEqual(['room-x', 'chan-b', 'chan-a'])
    expect((await store.list({ sort: { by: 'principalCount', dir: 'desc' }, limit: 1 })).map((r) => r.id)).toEqual(['chan-a'])
    expect((await store.list({ limit: 1, offset: 1 })).map((r) => r.id)).toEqual(['chan-b'])

    // searchPrincipals: store-global, distinct, ASC
    expect(await store.searchPrincipals({})).toEqual(['alice', 'bob', 'carol'])
    expect(await store.searchPrincipals({ query: 'b' })).toEqual(['bob'])

    // updated_at bumps on apply and setAccess; ACL index follows setAccess
    await new Promise((r) => setTimeout(r, 5))
    await store.apply({ id: 'chan-a', update: { v: 2 }, origin: 'c1' })
    expect((await store.list({ idContains: 'chan-a' }))[0]!.updatedAt).toBeGreaterThan(a.createdAt)

    await store.setAccess('chan-b', { dave: { read: true, write: true } })
    expect(await store.searchPrincipals({ query: 'dave' })).toEqual(['dave'])
    expect((await store.list({ principals: ['bob'] })).map((r) => r.id)).toEqual(['chan-a'])

    // delete drops the resource + its ACL rows
    await store.delete('chan-a')
    expect(await store.searchPrincipals({ query: 'alice' })).toEqual([])
  })
})

describe('pglite store — local replica feed (live.changes → onChange/onDelete)', () => {
  it('maps insert/update to onChange and delete to onDelete, carrying origin', async () => {
    const { store, db, table } = await makeStore()
    const changes: StoreChange[] = []
    const deletes: string[] = []
    store.onChange((c) => changes.push(c))
    store.onDelete?.((id) => deletes.push(id))

    // Simulate Electric streaming an INSERT into this node's local replica.
    await db.query(`INSERT INTO "${table}" (id, data, access, origin) VALUES ('x', '{"v":9}'::jsonb, '{}'::jsonb, 'c1')`)
    await waitFor(() => changes.some((c) => c.id === 'x'))
    const ins = changes.find((c) => c.id === 'x')
    expect(ins?.update).toEqual({ v: 9 })
    expect(ins?.origin).toBe('c1')

    // UPDATE → onChange with the new value + new origin.
    await db.query(`UPDATE "${table}" SET data = '{"v":10}'::jsonb, origin = 'c2' WHERE id = 'x'`)
    await waitFor(() => changes.some((c) => c.id === 'x' && JSON.stringify(c.update) === JSON.stringify({ v: 10 })))
    const upd = changes.filter((c) => c.id === 'x').at(-1)
    expect(upd?.origin).toBe('c2')

    // DELETE → onDelete.
    await db.query(`DELETE FROM "${table}" WHERE id = 'x'`)
    await waitFor(() => deletes.includes('x'))
  })
})
