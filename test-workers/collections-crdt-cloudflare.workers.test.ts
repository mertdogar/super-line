import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { afterEach, aroundEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import { crdtCloudflareCollections } from '@super-line/collections-crdt-cloudflare'
import { crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { createSuperLineClient } from '@super-line/client'
import type { CollectionDef, DocChange } from '@super-line/core'
import { peer, requireTitle, runCrdtConformance } from '../packages/collections-crdt-memory/test/crdt-store-conformance.js'
import { tick, waitFor } from '../packages/core/test/wait.js'
import { appContract, stubTransport } from './app.js'

// collections-crdt-cloudflare in a real Durable Object. Its storage is usable only inside the object, so each test
// in the first block runs inside `runInDurableObject` on a fresh one. A second backend over the same storage
// stands in for the instance a wake builds.

const doc = { schema: z.object({ title: z.string() }), crdt: { mode: 'document' as const } }
const defs: Record<string, CollectionDef> = { scenes: doc, notes: doc }
const o = { mode: 'document' as const }

const freshObject = () => env.STORE.get(env.STORE.idFromName(`crdt-${crypto.randomUUID()}`))
let storage: DurableObjectStorage
const make = (debounceMs = 5) => crdtCloudflareCollections(storage, defs, { debounceMs })
const snapshotOf = async (state: string | undefined | Promise<string | undefined>) => peer((await state) as string).sv.getSnapshot()

describe('collections-crdt-cloudflare in a fresh Durable Object', () => {
  aroundEach((runTest) =>
    runInDurableObject(freshObject(), async (_instance, state) => {
      storage = state.storage
      await runTest()
    }),
  )

  runCrdtConformance('collections-crdt-cloudflare', { make: () => make() })

  it('a new instance serves a stored doc with its Yjs history, so an old replica keeps merging cleanly', async () => {
    const s1 = make()
    s1.create('notes', 'n1', { title: 'hello' }, o)
    const p = peer(await s1.read('notes', 'n1'))
    s1.apply({ n: 'notes', id: 'n1', update: p.write(() => p.sv.doc.getText('prose').insert(0, 'abc')), origin: 'a' }, o, requireTitle)
    await s1.close?.()

    const s2 = make()
    s2.apply({ n: 'notes', id: 'n1', update: p.write(() => p.sv.doc.getText('prose').insert(3, 'def')), origin: 'a' }, o, requireTitle)
    const after = peer(await s2.read('notes', 'n1'))
    expect(after.sv.doc.getText('prose').toString()).toBe('abcdef') // same item ids: appended, not duplicated
    expect(after.sv.getSnapshot()).toEqual({ title: 'hello' })
  })

  it('loading a stored doc fans nothing out', async () => {
    make().create('scenes', 's1', { title: 'a' }, o)
    const s2 = make()
    const changes: DocChange[] = []
    s2.onChange((c) => changes.push(c))
    expect(await snapshotOf(s2.read('scenes', 's1'))).toEqual({ title: 'a' })
    s2.open('scenes', 's1').close()
    expect(changes).toEqual([])
  })

  it('writes edits through after the debounce, with no close', async () => {
    const s1 = make()
    s1.create('scenes', 's1', { title: 'a' }, o)
    const p = peer(await s1.read('scenes', 's1'))
    s1.apply({ n: 'scenes', id: 's1', update: p.write(() => p.sv.update({ title: 'b' })), origin: 'a' }, o, requireTitle)
    expect(await snapshotOf(make().read('scenes', 's1'))).toEqual({ title: 'a' }) // still pending
    await tick(30)
    expect(await snapshotOf(make().read('scenes', 's1'))).toEqual({ title: 'b' })
  })

  it('lists from storage: every doc, createdAt intact, filtered, sorted and paged', async () => {
    const s1 = make()
    for (const id of ['b', 'a', 'ab', 'c']) s1.create('scenes', id, { title: id }, o)
    s1.create('notes', 'x', { title: 'x' }, o)
    const before = await s1.list('scenes')

    const s2 = make()
    expect(await s2.list('scenes')).toEqual(before)
    expect(before.map((d) => d.id)).toEqual(['a', 'ab', 'b', 'c'])
    expect((await s2.list('scenes', { idContains: 'a' })).map((d) => d.id)).toEqual(['a', 'ab'])
    expect((await s2.list('scenes', { sort: { by: 'id', dir: 'desc' }, offset: 1, limit: 2 })).map((d) => d.id)).toEqual(['b', 'ab'])
    expect((await s2.list('notes')).map((d) => d.id)).toEqual(['x'])
  })

  it('a delete is durable, even with an edit still pending', async () => {
    const s1 = make()
    s1.create('scenes', 's1', { title: 'a' }, o)
    const p = peer(await s1.read('scenes', 's1'))
    s1.apply({ n: 'scenes', id: 's1', update: p.write(() => p.sv.update({ title: 'b' })), origin: 'a' }, o, requireTitle)
    s1.delete('scenes', 's1')
    await tick(30)
    const s2 = make()
    expect(await s2.read('scenes', 's1')).toBeUndefined()
    expect(await s2.list('scenes')).toEqual([])
  })

  it('create CONFLICTs against a stored doc this instance never loaded', () => {
    make().create('scenes', 's1', { title: 'a' }, o)
    expect(() => make().create('scenes', 's1', { title: 'b' }, o)).toThrow(/already exists/)
  })

  it('refuses a doc over the 2 MB a row holds, readably, and keeps serving the rest', async () => {
    const s1 = make()
    expect(() => s1.create('scenes', 'big', { title: 'x'.repeat(2_100_000) }, o)).toThrow(
      /scenes\/big is \d+ bytes, over the 2 MB a Durable Object row holds/,
    )
    expect(await s1.read('scenes', 'big')).toBeUndefined()

    s1.create('scenes', 's1', { title: 'small' }, o)
    const p = peer(await s1.read('scenes', 's1'))
    s1.apply({ n: 'scenes', id: 's1', update: p.write(() => p.sv.update({ title: 'y'.repeat(2_100_000) })), origin: 'a' }, o, requireTitle)
    await tick(30) // the write-through fails: the doc outgrew a row
    const next = p.write(() => p.sv.update({ title: 'z' }))
    expect(() => s1.apply({ n: 'scenes', id: 's1', update: next, origin: 'a' }, o, requireTitle)).toThrow(/over the 2 MB/)
    expect(await snapshotOf(make().read('scenes', 's1'))).toEqual({ title: 'small' }) // the last state that fit
    expect((await s1.list('scenes')).map((d) => d.id)).toEqual(['s1'])
  })
})

describe('collections-crdt-cloudflare across eviction', () => {
  const clients: Array<{ close(): void }> = []
  afterEach(() => {
    for (const c of clients.splice(0)) c.close()
  })

  it('a doc written before an eviction is served by the next instance', async () => {
    const stub = freshObject()
    await runInDurableObject(stub, async (_i, state) => {
      const store = crdtCloudflareCollections(state.storage, defs)
      store.create('scenes', 's1', { title: 'a' }, o)
      const p = peer(await store.read('scenes', 's1'))
      store.apply({ n: 'scenes', id: 's1', update: p.write(() => p.sv.update({ title: 'b' })), origin: 'a' }, o, requireTitle)
      await store.close?.()
    })
    await evictDurableObject(stub)
    const read = await runInDurableObject(stub, (_i, state) => crdtCloudflareCollections(state.storage, defs).read('scenes', 's1'))
    expect(await snapshotOf(read)).toEqual({ title: 'b' })
  })

  it('an open doc survives a wake: writes after it reach every holder, with zero lifecycle events', async () => {
    const stub = env.APP.get(env.APP.idFromName(`app-${crypto.randomUUID()}`))
    const lifecycle: string[] = []
    const connect = (uid: string) => {
      const client = createSuperLineClient(appContract, {
        transport: stubTransport(stub),
        role: 'user',
        params: { uid },
        crdtCollections: crdtCollectionsClient(),
        onDisconnect: (code) => lifecycle.push(`${uid}:disconnect:${code}`),
        onReconnect: () => lifecycle.push(`${uid}:reconnect`),
        onError: (err) => lifecycle.push(`${uid}:error:${String(err)}`),
      })
      clients.push(client)
      return client
    }
    const alice = connect('alice')
    const bob = connect('bob')
    await alice.createBoard({ id: 'b1', title: 'v1' })
    const mine = alice.collection('boards').open('b1')
    const theirs = bob.collection('boards').open('b1')
    await Promise.all([mine.ready, theirs.ready])

    mine.update({ title: 'v2' })
    await waitFor(() => theirs.getSnapshot()?.title === 'v2')
    await tick(400) // past the write-through debounce: a forced eviction, unlike hibernation, does not wait for it

    await evictDurableObject(stub)
    mine.update({ title: 'v3' }) // this write is what wakes the object
    await waitFor(() => theirs.getSnapshot()?.title === 'v3')

    const fresh = connect('carol').collection('boards').open('b1')
    await fresh.ready
    expect(fresh.getSnapshot()).toEqual({ title: 'v3' })
    expect(lifecycle).toEqual([])
  })
})
