import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    expect((await s.list()).sort()).toEqual(['a', 'b'])
    await s.delete('a')
    expect(await s.list()).toEqual(['b'])
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
    expect(await s2.list()).toEqual(['a'])
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
