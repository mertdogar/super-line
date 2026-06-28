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
    expect(await s2.list()).toEqual(['d'])
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
