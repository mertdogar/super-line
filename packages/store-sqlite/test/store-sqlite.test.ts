import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { StoreChange } from '@super-line/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sqliteStoreServer } from '../src/index.js'

const rules = { 'user-1': { read: true, write: true } }

/** Capture a synchronous throw (create/apply/setAccess are sync in the sqlite store). */
const thrown = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

let dir: string
const dbFile = () => join(dir, 'store.db')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-sqlite-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('sqliteStoreServer (LWW)', () => {
  it('declares relay clustering', () => {
    const s = sqliteStoreServer({ file: dbFile() })
    expect(s.clustering).toBe('relay')
    void s.close?.()
  })

  it('create + read round-trips a Resource', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('a', { n: 1 }, rules)
    expect(await s.read('a')).toEqual({ id: 'a', accessRules: rules, data: { n: 1 } })
    void s.close?.()
  })

  it('read of a missing id is undefined', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    expect(await s.read('nope')).toBeUndefined()
    void s.close?.()
  })

  it('create twice on the same id throws CONFLICT', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('a', {}, rules)
    expect(thrown(() => s.create('a', {}, rules))).toMatchObject({ code: 'CONFLICT' })
    void s.close?.()
  })

  it('apply replaces data (LWW) and fires onChange with the change', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('a', { n: 1 }, rules)
    const seen: StoreChange[] = []
    s.onChange((c) => seen.push(c))
    const change = { id: 'a', update: { n: 2 }, origin: 'w1' }
    await s.apply(change)
    expect((await s.read('a'))?.data).toEqual({ n: 2 })
    expect(seen).toEqual([change])
    void s.close?.()
  })

  it('apply to a missing id throws NOT_FOUND', () => {
    const s = sqliteStoreServer({ file: dbFile() })
    expect(thrown(() => s.apply({ id: 'x', update: 1, origin: 'w' }))).toMatchObject({ code: 'NOT_FOUND' })
    void s.close?.()
  })

  it('setAccess replaces access rules', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('a', {}, rules)
    await s.setAccess('a', { 'user-2': { read: true, write: false } })
    expect((await s.read('a'))?.accessRules).toEqual({ 'user-2': { read: true, write: false } })
    void s.close?.()
  })

  it('setAccess on a missing id throws NOT_FOUND', () => {
    const s = sqliteStoreServer({ file: dbFile() })
    expect(thrown(() => s.setAccess('x', rules))).toMatchObject({ code: 'NOT_FOUND' })
    void s.close?.()
  })

  it('delete removes and list reflects it', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('a', {}, rules)
    await s.create('b', {}, rules)
    expect((await s.list()).map((r) => r.id)).toEqual(['a', 'b']) // default sort: id ASC
    await s.delete('a')
    expect((await s.list()).map((r) => r.id)).toEqual(['b'])
    void s.close?.()
  })

  it('onChange returns a working unsubscribe', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('a', { n: 0 }, rules)
    const cb = vi.fn()
    const off = s.onChange(cb)
    off()
    await s.apply({ id: 'a', update: { n: 1 }, origin: 'w' })
    expect(cb).not.toHaveBeenCalled()
    void s.close?.()
  })

  it('persists Resources across a reopen (restart survival)', async () => {
    const file = dbFile()
    const s1 = sqliteStoreServer({ file })
    await s1.create('a', { n: 1 }, rules)
    await s1.apply({ id: 'a', update: { n: 2 }, origin: 'w' })
    await s1.close?.()

    const s2 = sqliteStoreServer({ file })
    expect(await s2.read('a')).toEqual({ id: 'a', accessRules: rules, data: { n: 2 } })
    expect((await s2.list()).map((r) => r.id)).toEqual(['a'])
    void s2.close?.()
  })

  it('isolates Resources by table on the same file', async () => {
    const file = dbFile()
    const chans = sqliteStoreServer({ file, table: 'channels' })
    const msgs = sqliteStoreServer({ file, table: 'messages' })
    await chans.create('x', { kind: 'chan' }, rules)
    await msgs.create('x', { kind: 'msg' }, rules)
    expect((await chans.read('x'))?.data).toEqual({ kind: 'chan' })
    expect((await msgs.read('x'))?.data).toEqual({ kind: 'msg' })
    void chans.close?.()
    void msgs.close?.()
  })

  it('stores arbitrary JSON values, including arrays', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('list', { items: [] }, rules)
    await s.apply({ id: 'list', update: { items: [{ id: 'm1', text: 'hi' }] }, origin: 'w' })
    expect((await s.read('list'))?.data).toEqual({ items: [{ id: 'm1', text: 'hi' }] })
    void s.close?.()
  })
})

describe('sqliteStoreServer (LWW) — list() filter / sort / paginate', () => {
  const rw = { read: true, write: true }

  it('summary carries principalCount + non-null createdAt/updatedAt', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('a', {}, { alice: rw, bob: rw })
    const row = (await s.list())[0]!
    expect(row.id).toBe('a')
    expect(row.principalCount).toBe(2)
    expect(row.createdAt).toBeGreaterThan(0)
    expect(row.updatedAt).toBeGreaterThanOrEqual(row.createdAt)
    void s.close?.()
  })

  it('idContains is a substring filter', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('chan-1', {}, rules)
    await s.create('chan-2', {}, rules)
    await s.create('msg-1', {}, rules)
    expect((await s.list({ idContains: 'chan' })).map((r) => r.id)).toEqual(['chan-1', 'chan-2'])
    void s.close?.()
  })

  it('idContains matches a literal underscore, not a LIKE wildcard', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('user_1', {}, rules)
    await s.create('userX1', {}, rules)
    expect((await s.list({ idContains: 'user_1' })).map((r) => r.id)).toEqual(['user_1'])
    void s.close?.()
  })

  it('principals is an OR/union filter; empty ⇒ all', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('a', {}, { alice: rw })
    await s.create('b', {}, { bob: rw })
    await s.create('c', {}, { carol: rw })
    expect((await s.list({ principals: ['alice', 'carol'] })).map((r) => r.id)).toEqual(['a', 'c'])
    expect((await s.list({ principals: [] })).map((r) => r.id)).toEqual(['a', 'b', 'c'])
    void s.close?.()
  })

  it('sorts by principalCount desc; default is id asc', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('a', {}, { p1: rw })
    await s.create('b', {}, { p1: rw, p2: rw, p3: rw })
    await s.create('c', {}, { p1: rw, p2: rw })
    expect((await s.list()).map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect((await s.list({ sort: { by: 'principalCount', dir: 'desc' } })).map((r) => r.id)).toEqual(['b', 'c', 'a'])
    void s.close?.()
  })

  it('limit omitted ⇒ unbounded; offset paginates', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    for (const id of ['a', 'b', 'c', 'd']) await s.create(id, {}, rules)
    expect((await s.list()).length).toBe(4)
    expect((await s.list({ limit: 2 })).map((r) => r.id)).toEqual(['a', 'b'])
    expect((await s.list({ limit: 2, offset: 2 })).map((r) => r.id)).toEqual(['c', 'd'])
    void s.close?.()
  })

  it('updatedAt bumps on apply AND setAccess; createdAt is stable', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('a', { n: 0 }, rules)
    const before = (await s.list())[0]!
    await new Promise((r) => setTimeout(r, 5))
    await s.apply({ id: 'a', update: { n: 1 }, origin: 'w' })
    const afterApply = (await s.list())[0]!
    expect(afterApply.createdAt).toBe(before.createdAt)
    expect(afterApply.updatedAt).toBeGreaterThan(before.updatedAt)
    await new Promise((r) => setTimeout(r, 5))
    await s.setAccess('a', { zed: rw })
    const afterAccess = (await s.list())[0]!
    expect(afterAccess.updatedAt).toBeGreaterThan(afterApply.updatedAt)
    void s.close?.()
  })

  it('setAccess + delete keep the ACL index in sync', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('a', {}, { alice: rw })
    await s.setAccess('a', { bob: rw }) // alice dropped, bob added
    expect((await s.list({ principals: ['alice'] })).length).toBe(0)
    expect((await s.list({ principals: ['bob'] })).map((r) => r.id)).toEqual(['a'])
    await s.delete('a')
    expect(await s.searchPrincipals({})).toEqual([])
    void s.close?.()
  })
})

describe('sqliteStoreServer (LWW) — searchPrincipals', () => {
  const rw = { read: true, write: true }
  it('distinct, substring-filtered, principal-ascending; store-global', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('a', {}, { alice: rw, bob: rw })
    await s.create('b', {}, { bob: rw, carol: rw }) // bob repeats → DISTINCT
    expect(await s.searchPrincipals({})).toEqual(['alice', 'bob', 'carol'])
    expect(await s.searchPrincipals({ query: 'a' })).toEqual(['alice', 'carol'])
    expect(await s.searchPrincipals({ limit: 1, offset: 1 })).toEqual(['bob'])
    void s.close?.()
  })
})

describe('sqliteStoreServer (LWW) — legacy migration', () => {
  it('backfills timestamps + ACL index from a pre-timestamp table', async () => {
    const file = dbFile()
    // Simulate an old on-disk table: id/data/access only, no timestamp cols, no _acl table.
    const legacy = new Database(file)
    legacy.exec(`CREATE TABLE "resources" (id TEXT PRIMARY KEY, data TEXT NOT NULL, access TEXT NOT NULL)`)
    legacy.prepare(`INSERT INTO "resources" (id, data, access) VALUES (?, ?, ?)`).run(
      'a',
      JSON.stringify({ n: 1 }),
      JSON.stringify({ alice: { read: true, write: true } }),
    )
    legacy.close()

    const s = sqliteStoreServer({ file })
    const row = (await s.list())[0]!
    expect(row.id).toBe('a')
    expect(row.principalCount).toBe(1)
    expect(row.createdAt).toBeGreaterThan(0)
    expect(await s.searchPrincipals({})).toEqual(['alice']) // backfilled from access JSON
    expect((await s.list({ principals: ['alice'] })).map((r) => r.id)).toEqual(['a'])
    void s.close?.()
  })
})

describe('sqliteStoreServer (LWW) — server-side open() replica', () => {
  it('getSnapshot reads persisted canonical state', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('a', { n: 1 }, rules)
    expect(s.open!('a').getSnapshot()).toEqual({ n: 1 })
    void s.close?.()
  })

  it('set/update/delete co-write durably and fan out through onChange', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('a', { keep: 1, drop: 2 }, rules)
    const seen: StoreChange[] = []
    s.onChange((c) => seen.push(c))
    const h = s.open!('a', { origin: 'agent' })

    h.update({ keep: 9 })
    h.delete(['drop'])

    expect((await s.read('a'))?.data).toEqual({ keep: 9 }) // persisted: merged then key removed
    expect(seen.map((c) => c.origin)).toEqual(['agent', 'agent'])
    void s.close?.()
  })

  it('subscribe fires for THIS id only; close releases it', async () => {
    const s = sqliteStoreServer({ file: dbFile() })
    await s.create('a', { n: 0 }, rules)
    await s.create('b', { n: 0 }, rules)
    const h = s.open!('a')
    const cb = vi.fn()
    h.subscribe(cb)
    await s.apply({ id: 'b', update: { n: 1 }, origin: 'w' })
    expect(cb).not.toHaveBeenCalled()
    await s.apply({ id: 'a', update: { n: 1 }, origin: 'w' })
    expect(cb).toHaveBeenCalledTimes(1)
    h.close()
    await s.apply({ id: 'a', update: { n: 2 }, origin: 'w' })
    expect(cb).toHaveBeenCalledTimes(1)
    void s.close?.()
  })
})
