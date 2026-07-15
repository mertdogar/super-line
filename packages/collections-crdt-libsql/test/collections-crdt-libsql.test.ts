import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoreValue } from '@super-store/store'
import { SuperLineError } from '@super-line/core'
import { crdtLibsqlCollections } from '@super-line/collections-crdt-libsql'

const b64 = (u: Uint8Array): string => {
  let s = ''
  for (const byte of u) s += String.fromCharCode(byte)
  return btoa(s)
}
const fromB64 = (s: string): Uint8Array => {
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}
function peer(seed?: string) {
  const sv = new StoreValue<Record<string, unknown>, 'document'>({}, { mode: 'document' })
  let pending: Uint8Array | null = null
  sv.onUpdate((u, meta) => {
    if (meta.local) pending = u
  })
  if (seed) sv.applyUpdate(fromB64(seed))
  return {
    sv,
    write(fn: () => void): string {
      pending = null
      fn()
      if (!pending) throw new Error('no delta')
      return b64(pending)
    },
  }
}
const requireTitle = (snap: unknown): void => {
  if (typeof (snap as { title?: unknown })?.title !== 'string') throw new SuperLineError('VALIDATION', 'bad title')
}
const docOptions = () => ({ mode: 'document' as const })

let dir: string
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('crdtLibsqlCollections (durable CRDT)', () => {
  // The relay-sync invariant (CrdtCollectionStore.apply), executable. This backend is the reason the rule is
  // written down at all: it keeps its hot path sync and persists off a debounced onChange precisely so that
  // durability never makes `apply` async — a constraint that lived only in this file's doc comment until the
  // seam was specified. Assert it, so the next durable backend cannot rediscover it the hard way.
  it('applies SYNCHRONOUSLY despite being durable — an async relay backend echo-storms the cluster', async () => {
    dir = mkdtempSync(join(tmpdir(), 'crdt-libsql-sync-'))
    const store = await crdtLibsqlCollections({ url: `file:${join(dir, 'sync.db')}`, debounceMs: 5, docOptions })
    expect(store.clustering).toBe('relay') // the invariant binds relay backends only
    store.create('scenes', 's1', { title: 'hello' }, docOptions())
    const p = peer(await store.read('scenes', 's1'))
    const delta = p.write(() => p.sv.update({ title: 'world' }))

    const returned = store.apply({ n: 'scenes', id: 's1', update: delta, origin: 'alice' }, docOptions(), requireTitle)
    expect(typeof (returned as { then?: unknown })?.then).not.toBe('function')
    await returned
    await store.close?.()
  })

  it('persists across a close/reopen (rehydrates full Yjs state)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'crdt-libsql-'))
    const url = `file:${join(dir, 'a.db')}`

    const s1 = await crdtLibsqlCollections({ url, debounceMs: 5, docOptions })
    s1.create('scenes', 's1', { title: 'hello' }, docOptions())
    const p = peer(await s1.read('scenes', 's1'))
    const delta = p.write(() => p.sv.update({ title: 'world', n: 1 }))
    s1.apply({ n: 'scenes', id: 's1', update: delta, origin: 'alice' }, docOptions(), requireTitle)
    await s1.close?.() // flushes pending snapshot

    // reopen a fresh backend against the same file → the doc rehydrates
    const s2 = await crdtLibsqlCollections({ url, debounceMs: 5, docOptions })
    const after = peer(await s2.read('scenes', 's1'))
    expect(after.sv.getSnapshot()).toMatchObject({ title: 'world', n: 1 })
    expect((await s2.list('scenes')).map((r) => r.id)).toEqual(['s1'])
    await s2.close?.()
  })

  it('validate-before-commit rejects an invalid delta (canonical untouched); delete removes durably', async () => {
    dir = mkdtempSync(join(tmpdir(), 'crdt-libsql-'))
    const url = `file:${join(dir, 'b.db')}`
    const s1 = await crdtLibsqlCollections({ url, debounceMs: 5, docOptions })
    s1.create('scenes', 's1', { title: 'ok' }, docOptions())
    const p = peer(await s1.read('scenes', 's1'))
    const bad = p.write(() => p.sv.set({ title: 42 }))
    expect(() => s1.apply({ n: 'scenes', id: 's1', update: bad, origin: 'a' }, docOptions(), requireTitle)).toThrow(/bad title/)

    s1.delete('scenes', 's1')
    await s1.close?.()
    const s2 = await crdtLibsqlCollections({ url, debounceMs: 5, docOptions })
    expect(await s2.read('scenes', 's1')).toBeUndefined() // delete persisted
    await s2.close?.()
  })
})
