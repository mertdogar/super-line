import type { StoreChange } from '@super-line/core'
import { describe, expect, it, vi } from 'vitest'
import { memoryStoreClient, memoryStoreServer } from '../src/index.js'

const rules = { 'user-1': { read: true, write: true } }

/** Capture a synchronous throw (create/apply are sync in the memory store). */
const thrown = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

describe('memoryStoreServer (LWW)', () => {
  it('declares relay clustering', () => {
    expect(memoryStoreServer().clustering).toBe('relay')
  })

  it('create + read round-trips a Resource', async () => {
    const s = memoryStoreServer()
    await s.create('a', { n: 1 }, rules)
    expect(await s.read('a')).toEqual({ id: 'a', accessRules: rules, data: { n: 1 } })
  })

  it('read of a missing id is undefined', async () => {
    expect(await memoryStoreServer().read('nope')).toBeUndefined()
  })

  it('create twice on the same id throws CONFLICT', async () => {
    const s = memoryStoreServer()
    await s.create('a', {}, rules)
    expect(thrown(() => s.create('a', {}, rules))).toMatchObject({ code: 'CONFLICT' })
  })

  it('apply replaces data (LWW) and fires onChange with the change', async () => {
    const s = memoryStoreServer()
    await s.create('a', { n: 1 }, rules)
    const seen: StoreChange[] = []
    s.onChange((c) => seen.push(c))
    const change = { id: 'a', update: { n: 2 }, origin: 'w1' }
    await s.apply(change)
    expect((await s.read('a'))?.data).toEqual({ n: 2 })
    expect(seen).toEqual([change])
  })

  it('apply to a missing id throws NOT_FOUND', () => {
    expect(thrown(() => memoryStoreServer().apply({ id: 'x', update: 1, origin: 'w' }))).toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('setAccess replaces access rules', async () => {
    const s = memoryStoreServer()
    await s.create('a', {}, rules)
    await s.setAccess('a', { 'user-2': { read: true, write: false } })
    expect((await s.read('a'))?.accessRules).toEqual({ 'user-2': { read: true, write: false } })
  })

  it('delete removes and list reflects it', async () => {
    const s = memoryStoreServer()
    await s.create('a', {}, rules)
    await s.create('b', {}, rules)
    expect((await s.list()).sort()).toEqual(['a', 'b'])
    await s.delete('a')
    expect(await s.list()).toEqual(['b'])
  })

  it('onChange returns a working unsubscribe', async () => {
    const s = memoryStoreServer()
    await s.create('a', { n: 0 }, rules)
    const cb = vi.fn()
    const off = s.onChange(cb)
    off()
    await s.apply({ id: 'a', update: { n: 1 }, origin: 'w' })
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('memoryStoreServer (LWW) — server-side open() replica', () => {
  it('getSnapshot reads canonical state live', async () => {
    const s = memoryStoreServer()
    await s.create('a', { n: 1 }, rules)
    expect(s.open!('a').getSnapshot()).toEqual({ n: 1 })
  })

  it('set co-writes (replace) and fans out through onChange with the origin', async () => {
    const s = memoryStoreServer()
    await s.create('a', { n: 1 }, rules)
    const seen: StoreChange[] = []
    s.onChange((c) => seen.push(c))
    s.open!('a', { origin: 'agent' }).set({ n: 2 })
    expect((await s.read('a'))?.data).toEqual({ n: 2 })
    expect(seen).toEqual([{ id: 'a', update: { n: 2 }, origin: 'agent' }])
  })

  it('update merges (shallow) and fans out', async () => {
    const s = memoryStoreServer()
    await s.create('a', { a: 1, b: 2 }, rules)
    s.open!('a').update({ b: 3 })
    expect((await s.read('a'))?.data).toEqual({ a: 1, b: 3 })
  })

  it('delete(path) removes a key WITHOUT mutating the prior snapshot in place (clobber-safe)', async () => {
    const s = memoryStoreServer()
    await s.create('a', { keep: 1, drop: 2 }, rules)
    const h = s.open!('a')
    const before = h.getSnapshot() // the live canonical object
    h.delete(['drop'])
    expect(h.getSnapshot()).toEqual({ keep: 1 })
    expect(before).toEqual({ keep: 1, drop: 2 }) // prior snapshot untouched — a fresh value was set
  })

  it('subscribe fires for THIS id only; close releases it', async () => {
    const s = memoryStoreServer()
    await s.create('a', { n: 0 }, rules)
    await s.create('b', { n: 0 }, rules)
    const h = s.open!('a')
    const cb = vi.fn()
    h.subscribe(cb)
    await s.apply({ id: 'b', update: { n: 1 }, origin: 'w' }) // other id — no fire
    expect(cb).not.toHaveBeenCalled()
    await s.apply({ id: 'a', update: { n: 1 }, origin: 'w' }) // this id — fires
    expect(cb).toHaveBeenCalledTimes(1)
    h.close()
    await s.apply({ id: 'a', update: { n: 2 }, origin: 'w' }) // released
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('memoryStoreClient (LWW)', () => {
  it('distinct client instances get distinct origins', () => {
    expect(memoryStoreClient().origin).not.toBe(memoryStoreClient().origin)
  })

  it('honors an explicit origin', () => {
    expect(memoryStoreClient({ origin: 'fixed' }).origin).toBe('fixed')
  })

  it('a fresh replica has no snapshot until seeded', () => {
    const r = memoryStoreClient().open('a')
    expect(r.getSnapshot()).toBeUndefined()
    r.seed({ n: 1 })
    expect(r.getSnapshot()).toEqual({ n: 1 })
  })

  it('seed notifies subscribers', () => {
    const r = memoryStoreClient().open('a')
    const cb = vi.fn()
    r.subscribe(cb)
    r.seed({ n: 1 })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('set replaces, notifies, and returns a Change stamped with the origin', () => {
    const r = memoryStoreClient({ origin: 'w1' }).open('a')
    const cb = vi.fn()
    r.subscribe(cb)
    const change = r.set({ n: 5 })
    expect(change).toEqual({ id: 'a', update: { n: 5 }, origin: 'w1' })
    expect(r.getSnapshot()).toEqual({ n: 5 })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('set of the same reference is a no-op (null, no notify)', () => {
    const r = memoryStoreClient().open('a')
    const v = { n: 1 }
    r.set(v)
    const cb = vi.fn()
    r.subscribe(cb)
    expect(r.set(v)).toBeNull()
    expect(cb).not.toHaveBeenCalled()
  })

  it('update merges into the current object value', () => {
    const r = memoryStoreClient().open('a')
    r.seed({ a: 1, b: 2 })
    const change = r.update({ b: 3 })
    expect(r.getSnapshot()).toEqual({ a: 1, b: 3 })
    expect(change?.update).toEqual({ a: 1, b: 3 })
  })

  it('applyRemote with a foreign origin replaces and notifies', () => {
    const r = memoryStoreClient({ origin: 'mine' }).open('a')
    const cb = vi.fn()
    r.subscribe(cb)
    r.applyRemote({ id: 'a', update: { n: 9 }, origin: 'other' })
    expect(r.getSnapshot()).toEqual({ n: 9 })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('applyRemote with our own origin is skipped (echo-break)', () => {
    const r = memoryStoreClient({ origin: 'mine' }).open('a')
    r.seed({ n: 1 })
    const cb = vi.fn()
    r.subscribe(cb)
    r.applyRemote({ id: 'a', update: { n: 9 }, origin: 'mine' })
    expect(r.getSnapshot()).toEqual({ n: 1 })
    expect(cb).not.toHaveBeenCalled()
  })
})
