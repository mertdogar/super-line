import { describe, it, expect } from 'vitest'
import { StoreValue } from '@super-store/store'
import { SuperLineError } from '@super-line/core'
import type { DocChange } from '@super-line/core'
import { crdtMemoryCollections } from '@super-line/collections-crdt-memory'

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

// A test "client": a StoreValue seeded from the backend's catch-up state; its local writes produce deltas.
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
      if (!pending) throw new Error('no delta produced')
      return b64(pending)
    },
  }
}

// Require `title` to be a string — a stand-in for the contract-schema validate the server injects.
const requireTitle = (snapshot: unknown): void => {
  if (typeof (snapshot as { title?: unknown })?.title !== 'string')
    throw new SuperLineError('VALIDATION', 'title must be a string')
}

describe('crdtMemoryCollections', () => {
  // The relay-sync invariant (CrdtCollectionStore.apply), executable. The server's relay ingress sets a
  // re-publish guard, applies, and clears the guard in `finally` — which only holds while apply emits
  // onChange before returning. An async apply clears the guard first and the delta ping-pongs across the
  // cluster forever. `origin` cannot substitute: it names the WRITER and survives the relay, so a receiving
  // node cannot tell a relayed delta from a local write by that same writer.
  it('applies SYNCHRONOUSLY — a relay backend that returns a promise echo-storms the cluster', async () => {
    const store = crdtMemoryCollections()
    expect(store.clustering).toBe('relay') // the invariant binds relay backends only
    store.create('scenes', 's1', { title: 'hello' }, { mode: 'document' })
    const p = peer(await store.read('scenes', 's1'))
    const delta = p.write(() => p.sv.update({ title: 'world' }))

    const returned = store.apply({ n: 'scenes', id: 's1', update: delta, origin: 'alice' }, { mode: 'document' }, requireTitle)
    expect(typeof (returned as { then?: unknown })?.then).not.toBe('function')
    await returned
  })

  it('creates a doc and serves catch-up state; a valid delta merges and fans out', async () => {
    const store = crdtMemoryCollections()
    const changes: DocChange[] = []
    store.onChange((c) => changes.push(c))

    store.create('scenes', 's1', { title: 'hello' }, { mode: 'document' })
    const seed = await store.read('scenes', 's1')
    expect(seed).toBeTypeOf('string')

    const p = peer(seed)
    const delta = p.write(() => p.sv.update({ title: 'world' }))
    store.apply({ n: 'scenes', id: 's1', update: delta, origin: 'alice' }, { mode: 'document' }, requireTitle)

    expect(changes.length).toBe(1)
    expect(changes[0]).toMatchObject({ n: 'scenes', id: 's1', origin: 'alice' })
    // canonical merged the write
    const after = peer(await store.read('scenes', 's1'))
    expect(after.sv.getSnapshot()).toMatchObject({ title: 'world' })
  })

  it('rejects an invalid delta (validate-before-commit): canonical untouched, nothing fanned', async () => {
    const store = crdtMemoryCollections()
    const changes: DocChange[] = []
    store.onChange((c) => changes.push(c))
    store.create('scenes', 's1', { title: 'ok' }, { mode: 'document' })

    const p = peer(await store.read('scenes', 's1'))
    const badDelta = p.write(() => p.sv.set({ title: 42 })) // title becomes a number → invalid

    expect(() =>
      store.apply({ n: 'scenes', id: 's1', update: badDelta, origin: 'alice' }, { mode: 'document' }, requireTitle),
    ).toThrow(/title must be a string/)
    expect(changes.length).toBe(0) // nothing fanned
    const after = peer(await store.read('scenes', 's1'))
    expect(after.sv.getSnapshot()).toMatchObject({ title: 'ok' }) // canonical unchanged
  })

  it('server co-writer (open) mutates canonical and fans out', () => {
    const store = crdtMemoryCollections()
    const changes: DocChange[] = []
    store.onChange((c) => changes.push(c))
    store.create('scenes', 's1', { title: 'a' }, { mode: 'document' })

    const replica = store.open('scenes', 's1')
    replica.update({ title: 'b' })
    expect(replica.getSnapshot()).toMatchObject({ title: 'b' })
    expect(changes.some((c) => c.origin === 'server')) .toBe(true)
    replica.close()
  })

  it('enumerates ids (list) and deletes', async () => {
    const store = crdtMemoryCollections()
    store.create('scenes', 'b', { title: '1' }, { mode: 'document' })
    store.create('scenes', 'a', { title: '2' }, { mode: 'document' })
    expect((await store.list('scenes')).map((r) => r.id)).toEqual(['a', 'b'])

    store.delete('scenes', 'a')
    expect((await store.list('scenes')).map((r) => r.id)).toEqual(['b'])
    expect(await store.read('scenes', 'a')).toBeUndefined()
  })

  it('CONFLICT on create of an existing id; NOT_FOUND on apply to an absent doc', () => {
    const store = crdtMemoryCollections()
    store.create('scenes', 's1', { title: 'a' }, { mode: 'document' })
    expect(() => store.create('scenes', 's1', { title: 'b' }, { mode: 'document' })).toThrow(/already exists/)
    const p = peer()
    const delta = p.write(() => p.sv.update({ title: 'x' }))
    expect(() => store.apply({ n: 'scenes', id: 'nope', update: delta, origin: 'a' }, { mode: 'document' }, requireTitle)).toThrow(
      /No document/,
    )
  })
})
