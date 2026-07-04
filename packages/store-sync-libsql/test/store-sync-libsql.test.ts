import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { syncStoreClient } from '@super-line/store-sync'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { libsqlSyncStore } from '../src/index.js'

const rules = { alice: { read: true, write: true } }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let dir: string
const fileUrl = (): string => `file:${join(dir, 'store.db')}`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-libsql-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const rowState = async (url: string, id: string): Promise<string | undefined> => {
  const c = createClient({ url })
  const { rows } = await c.execute({ sql: 'SELECT state FROM resources WHERE id = ?', args: [id] })
  c.close()
  return rows[0]?.state as string | undefined
}

describe('libsqlSyncStore — declarations + skeleton (B1)', () => {
  it('rejects an invalid table name', async () => {
    await expect(libsqlSyncStore({ url: ':memory:', table: 'bad name' })).rejects.toThrow(/Invalid table name/)
  })

  it('delegates clustering + model to the inner sync store', async () => {
    const s = await libsqlSyncStore({ url: ':memory:' })
    expect(s.clustering).toBe('relay')
    expect(s.model).toBe('crdt')
    await s.close?.()
  })

  it('persists the encoded snapshot after the debounce window', async () => {
    const url = fileUrl()
    const s = await libsqlSyncStore({ url, debounceMs: 20 })
    await s.create('d', { title: 'x' }, rules)
    const h = s.open!('d', { origin: 'agent' })
    h.update({ title: 'y', n: 1 })

    await sleep(60)
    expect(await rowState(url, 'd')).toBe((await s.read('d'))?.data) // row state === encodeState()
    await s.close?.()
  })

  it('create writes the initial row immediately (no onChange to debounce)', async () => {
    const url = fileUrl()
    const s = await libsqlSyncStore({ url })
    await s.create('d', { title: 'x' }, rules)
    expect(await rowState(url, 'd')).toBe((await s.read('d'))?.data)
    await s.close?.()
  })
})

describe('libsqlSyncStore — rehydrate on restart (B2)', () => {
  it('restores doc state across a close + reopen over the same file', async () => {
    const url = fileUrl()
    const s1 = await libsqlSyncStore({ url, debounceMs: 10 })
    await s1.create('d', { title: 'x' }, rules)
    const h = s1.open!('d', { origin: 'agent' })
    h.update({ title: 'y', count: 3 })
    await sleep(40)
    await s1.close?.()

    const s2 = await libsqlSyncStore({ url })
    expect((await s2.list()).map((r) => r.id)).toEqual(['d'])
    expect((await s2.read('d'))?.accessRules).toEqual(rules)
    expect(s2.open!('d').getSnapshot()).toEqual({ title: 'y', count: 3 })
    await s2.close?.()
  })

  it('a concurrent-field CRDT merge survives the round-trip', async () => {
    const url = fileUrl()
    const s1 = await libsqlSyncStore({ url, debounceMs: 10 })
    await s1.create('d', { title: 'base' }, rules)
    const base = (await s1.read('d'))!.data

    // two independent replicas seeded from the same base produce concurrent deltas to different fields
    const r1 = syncStoreClient().open('d')
    r1.seed(base)
    const c1 = r1.update({ a: 1 })
    const r2 = syncStoreClient().open('d')
    r2.seed(base)
    const c2 = r2.update({ b: 2 })
    await s1.apply(c1!)
    await s1.apply(c2!)

    await sleep(40)
    await s1.close?.()

    const s2 = await libsqlSyncStore({ url })
    expect(s2.open!('d').getSnapshot()).toEqual({ title: 'base', a: 1, b: 2 }) // both merged fields survived
    await s2.close?.()
  })
})

describe('libsqlSyncStore — delete + setAccess (B3)', () => {
  it('delete removes the row and it stays gone after a reopen (no resurrection)', async () => {
    const url = fileUrl()
    const s1 = await libsqlSyncStore({ url, debounceMs: 10 })
    await s1.create('d', { title: 'x' }, rules)
    const h = s1.open!('d', { origin: 'agent' })
    h.update({ title: 'y' }) // schedules a debounced flush
    await s1.delete('d') // must cancel that flush
    await sleep(40)
    expect(await rowState(url, 'd')).toBeUndefined()
    await s1.close?.()

    const s2 = await libsqlSyncStore({ url })
    expect(await s2.list()).toEqual([])
    await s2.close?.()
  })
})

describe('libsqlSyncStore — list/searchPrincipals (B4)', () => {
  it('list returns ResourceSummary rows with counts + timestamps, id-asc by default', async () => {
    const s = await libsqlSyncStore({ url: fileUrl() })
    await s.create('beta', {}, { alice: { read: true, write: true }, bob: { read: true, write: false } })
    await s.create('alpha', {}, { alice: { read: true, write: true } })

    const rows = await s.list()
    expect(rows.map((r) => r.id)).toEqual(['alpha', 'beta']) // id ASC (binary)
    const beta = rows.find((r) => r.id === 'beta')!
    expect(beta.principalCount).toBe(2)
    expect(typeof beta.createdAt).toBe('number')
    expect(beta.createdAt).toBeGreaterThan(0)
    expect(beta.updatedAt).toBeGreaterThanOrEqual(beta.createdAt)
    await s.close?.()
  })

  it('idContains is a case-sensitive substring filter', async () => {
    const s = await libsqlSyncStore({ url: fileUrl() })
    await s.create('doc-1', {}, rules)
    await s.create('doc-2', {}, rules)
    await s.create('note', {}, rules)
    await s.create('DOC-3', {}, rules)

    expect((await s.list({ idContains: 'doc' })).map((r) => r.id)).toEqual(['doc-1', 'doc-2']) // not DOC-3
    await s.close?.()
  })

  it('principals is an OR/union filter', async () => {
    const s = await libsqlSyncStore({ url: fileUrl() })
    await s.create('a', {}, { alice: { read: true, write: true } })
    await s.create('b', {}, { bob: { read: true, write: true } })
    await s.create('c', {}, { carol: { read: true, write: true } })

    expect((await s.list({ principals: ['alice', 'bob'] })).map((r) => r.id)).toEqual(['a', 'b'])
    expect((await s.list({ principals: [] })).map((r) => r.id)).toEqual(['a', 'b', 'c']) // empty ⇒ no filter
    await s.close?.()
  })

  it('sorts by principalCount desc and paginates', async () => {
    const s = await libsqlSyncStore({ url: fileUrl() })
    await s.create('one', {}, { a: { read: true, write: true } })
    await s.create('three', {}, { a: { read: true, write: true }, b: { read: true, write: true }, c: { read: true, write: true } })
    await s.create('two', {}, { a: { read: true, write: true }, b: { read: true, write: true } })

    expect((await s.list({ sort: { by: 'principalCount', dir: 'desc' } })).map((r) => r.id)).toEqual(['three', 'two', 'one'])
    expect((await s.list({ sort: { by: 'principalCount', dir: 'desc' }, limit: 1, offset: 1 })).map((r) => r.id)).toEqual(['two'])
    await s.close?.()
  })

  it('updatedAt bumps on setAccess but createdAt is stable', async () => {
    const s = await libsqlSyncStore({ url: fileUrl() })
    await s.create('d', {}, rules)
    const before = (await s.list())[0]!
    await sleep(5)
    await s.setAccess('d', { bob: { read: true, write: false } })
    const after = (await s.list())[0]!
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt)
    expect(after.principalCount).toBe(1)
    await s.close?.()
  })

  it('searchPrincipals is distinct, substring-filtered, principal-asc', async () => {
    const s = await libsqlSyncStore({ url: fileUrl() })
    await s.create('x', {}, { alice: { read: true, write: true }, bob: { read: true, write: true } })
    await s.create('y', {}, { alice: { read: true, write: true }, carol: { read: true, write: true } })

    expect(await s.searchPrincipals({})).toEqual(['alice', 'bob', 'carol']) // distinct + asc
    expect(await s.searchPrincipals({ query: 'a' })).toEqual(['alice', 'carol']) // substring on principal
    expect(await s.searchPrincipals({ limit: 1, offset: 1 })).toEqual(['bob'])
    await s.close?.()
  })

  it('setAccess persists across a reopen', async () => {
    const url = fileUrl()
    const s1 = await libsqlSyncStore({ url })
    await s1.create('d', { title: 'x' }, rules)
    await s1.setAccess('d', { bob: { read: true, write: false } })
    await s1.close?.()

    const s2 = await libsqlSyncStore({ url })
    expect((await s2.read('d'))?.accessRules).toEqual({ bob: { read: true, write: false } })
    await s2.close?.()
  })
})
