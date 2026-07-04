import { defineContract } from '@super-line/core'
import { createSuperLineClient, type SuperLineClient } from '@super-line/client'
import { createSuperLineServer } from '@super-line/server'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncStoreClient, syncStoreServer } from '../src/index.js'

const contract = defineContract({ roles: { user: { clientToServer: {} } } })
type Client = SuperLineClient<typeof contract, 'user'>
type Note = { title?: string; a?: number; b?: number }

async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const rules = { alice: { read: true, write: true }, bob: { read: true, write: true } }

function setup() {
  const loop = createLoopbackTransport()
  const srv = createSuperLineServer(contract, {
    transports: [loop.server],
    authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid } }),
    identify: (conn) => (conn.ctx as { uid?: string }).uid,
    stores: { docs: syncStoreServer() },
  })
  const clients: Client[] = []
  const makeClient = (uid: string): Client => {
    const cl = createSuperLineClient(contract, {
      transport: loop.client(),
      role: 'user',
      params: { uid },
      stores: { docs: syncStoreClient() },
    })
    clients.push(cl)
    return cl
  }
  return { srv, makeClient, clients }
}

describe('store-sync (CRDT)', () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })
  afterEach(async () => {
    for (const c of env.clients) c.close()
    await env.srv.close()
  })

  it('catches up to the server snapshot', async () => {
    await env.srv.store('docs').create('d', { title: 'x' }, rules)
    const h = env.makeClient('alice').store('docs').open('d')
    await h.ready
    expect((h.getSnapshot() as Note).title).toBe('x')
  })

  it('propagates a write to another subscriber', async () => {
    await env.srv.store('docs').create('d', { title: 'x' }, rules)
    const ha = env.makeClient('alice').store('docs').open('d')
    const hb = env.makeClient('bob').store('docs').open('d')
    await Promise.all([ha.ready, hb.ready])

    ha.update({ title: 'y' })
    await waitFor(() => (hb.getSnapshot() as Note).title === 'y')
  })

  it('merges CONCURRENT writes to different fields (the LWW failure mode)', async () => {
    await env.srv.store('docs').create('d', { title: 'x' }, rules)
    const ha = env.makeClient('alice').store('docs').open('d')
    const hb = env.makeClient('bob').store('docs').open('d')
    await Promise.all([ha.ready, hb.ready])

    // both edit at the "same time", each touching a different field
    ha.update({ a: 1 })
    hb.update({ b: 2 })

    // CRDT convergence: neither write clobbers the other — both fields survive on both replicas
    await waitFor(() => {
      const a = ha.getSnapshot() as Note
      const b = hb.getSnapshot() as Note
      return a.a === 1 && a.b === 2 && b.a === 1 && b.b === 2
    })
    expect((ha.getSnapshot() as Note).title).toBe('x') // untouched field preserved
    expect((await env.srv.store('docs').read('d')) !== undefined).toBe(true) // canonical doc exists
  })

  it('a server co-write MERGES (partial), preserving untouched fields, and fans out', async () => {
    await env.srv.store('docs').create('d', { title: 'x' }, { alice: { read: true, write: true } })
    const ha = env.makeClient('alice').store('docs').open('d')
    await ha.ready

    await env.srv.store('docs').write('d', { a: 9 }) // partial co-write
    await waitFor(() => (ha.getSnapshot() as Note).a === 9)
    expect((ha.getSnapshot() as Note).title).toBe('x') // untouched field survives (merge, not replace)
  })
})

// Document mode over the real wire — the consumer's actual scenario. The SAME
// resolveOptions is supplied to both halves (one shared source → no config drift).
type Scene = { el: { x: number; color: string } }
const sceneOptions = { mode: 'document' as const }
const resolveOptions = () => sceneOptions

function setupDoc() {
  const loop = createLoopbackTransport()
  const srv = createSuperLineServer(contract, {
    transports: [loop.server],
    authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid } }),
    identify: (conn) => (conn.ctx as { uid?: string }).uid,
    stores: { docs: syncStoreServer({ resolveOptions }) },
  })
  const clients: Client[] = []
  const makeClient = (uid: string): Client => {
    const cl = createSuperLineClient(contract, {
      transport: loop.client(),
      role: 'user',
      params: { uid },
      stores: { docs: syncStoreClient({ resolveOptions }) },
    })
    clients.push(cl)
    return cl
  }
  return { srv, makeClient, clients }
}

describe('store-sync (CRDT) — document mode', () => {
  let env: ReturnType<typeof setupDoc>
  beforeEach(() => {
    env = setupDoc()
  })
  afterEach(async () => {
    for (const c of env.clients) c.close()
    await env.srv.close()
  })

  it('merges concurrent writes to different fields of the SAME nested object', async () => {
    await env.srv.store('docs').create('scene', { el: { x: 1, color: 'red' } }, rules)
    const ha = env.makeClient('alice').store('docs').open('scene')
    const hb = env.makeClient('bob').store('docs').open('scene')
    await Promise.all([ha.ready, hb.ready])

    // The LWW failure mode shallow mode can't escape: both edit the SAME nested
    // object, different fields. Document mode field-merges; neither is lost.
    ha.update({ el: { x: 2 } })
    hb.update({ el: { color: 'blue' } })

    await waitFor(() => {
      const a = ha.getSnapshot() as Scene
      const b = hb.getSnapshot() as Scene
      return a.el.x === 2 && a.el.color === 'blue' && b.el.x === 2 && b.el.color === 'blue'
    })
  })
})

// Design A — the server half can open a reactive in-process replica over canonical state,
// symmetric to the client's open(id). It is the delete-capable, reactive server co-writer.
describe('store-sync (CRDT) — server-side ServerReplica (Design A)', () => {
  let env: ReturnType<typeof setupDoc>
  beforeEach(() => {
    env = setupDoc()
  })
  afterEach(async () => {
    for (const c of env.clients) c.close()
    await env.srv.close()
  })

  it('open(id) gives a server-side handle that reads canonical state', async () => {
    await env.srv.store('docs').create('scene', { el: { x: 1, color: 'red' } }, rules)
    const h = env.srv.store('docs').open('scene')
    expect((h.getSnapshot() as Scene).el.x).toBe(1)
    h.close()
  })

  it('delete(path) removes a key and fans out the removal to a client', async () => {
    await env.srv.store('docs').create('scene', { elements: { e1: { x: 1 }, e2: { x: 2 } } }, rules)
    const cl = env.makeClient('alice').store('docs').open('scene')
    await cl.ready
    const agent = env.srv.store('docs').open('scene')

    agent.delete(['elements', 'e1'])

    await waitFor(() => (cl.getSnapshot() as { elements: Record<string, unknown> }).elements.e1 === undefined)
    expect((cl.getSnapshot() as { elements: Record<string, unknown> }).elements.e2).toEqual({ x: 2 })
    agent.close()
  })

  it('a server delete MERGES with a concurrent client edit to a sibling key (no clobber)', async () => {
    await env.srv.store('docs').create('scene', { elements: { e1: { x: 1 }, e2: { x: 2 } } }, rules)
    const cl = env.makeClient('alice').store('docs').open('scene')
    await cl.ready
    const agent = env.srv.store('docs').open('scene')

    // concurrent: client edits e2.x, agent deletes e1 — the surgical delete must not clobber e2's edit
    cl.update({ elements: { e2: { x: 99 } } })
    agent.delete(['elements', 'e1'])

    type Els = { elements: Record<string, { x: number } | undefined> }
    await waitFor(() => {
      const s = cl.getSnapshot() as Els
      return s.elements.e1 === undefined && s.elements.e2?.x === 99
    })
    expect((env.srv.store('docs').open('scene').getSnapshot() as Els).elements.e2?.x).toBe(99) // canonical too
    agent.close()
  })

  it('subscribe reactively reflects a client write (the read side)', async () => {
    await env.srv.store('docs').create('scene', { el: { x: 1, color: 'red' } }, rules)
    const agent = env.srv.store('docs').open('scene')
    let fired = 0
    agent.subscribe(() => fired++)
    const cl = env.makeClient('alice').store('docs').open('scene')
    await cl.ready

    cl.update({ el: { x: 7 } })

    await waitFor(() => (agent.getSnapshot() as Scene).el.x === 7)
    expect(fired).toBeGreaterThan(0)
    expect((agent.getSnapshot() as Scene).el.color).toBe('red') // merge, not replace
    agent.close()
  })

  it('update co-writes (merge) and fans out, preserving untouched fields', async () => {
    await env.srv.store('docs').create('scene', { el: { x: 1, color: 'red' } }, rules)
    const cl = env.makeClient('alice').store('docs').open('scene')
    await cl.ready
    const agent = env.srv.store('docs').open('scene')

    agent.update({ el: { x: 5 } })

    await waitFor(() => (cl.getSnapshot() as Scene).el.x === 5)
    expect((cl.getSnapshot() as Scene).el.color).toBe('red') // untouched field survives
    agent.close()
  })

  it('close() releases the handle listener; sibling handles + canonical state stay live', async () => {
    await env.srv.store('docs').create('scene', { el: { x: 0, color: 'red' } }, rules)
    const a = env.srv.store('docs').open('scene')
    const b = env.srv.store('docs').open('scene')
    let aFired = 0
    let bFired = 0
    a.subscribe(() => aFired++)
    b.subscribe(() => bFired++)
    const cl = env.makeClient('alice').store('docs').open('scene')
    await cl.ready

    cl.update({ el: { x: 1 } })
    await waitFor(() => (b.getSnapshot() as Scene).el.x === 1)
    const aBeforeClose = aFired

    a.close()
    cl.update({ el: { x: 2 } })
    await waitFor(() => (b.getSnapshot() as Scene).el.x === 2)

    expect(aFired).toBe(aBeforeClose) // a's listener released — no further notifications
    expect(bFired).toBeGreaterThan(0) // b still live
    expect((b.getSnapshot() as Scene).el.x).toBe(2) // canonical state intact, b reads it
    b.close()
  })
})

// R4 — the CLIENT replica gets the same surgical delete(path), so a browser mirror can remove an element
// without the full-document `set` that clobbers a concurrent peer's edit to other elements.
describe('store-sync (CRDT) — client delete(path) (R4)', () => {
  let env: ReturnType<typeof setupDoc>
  beforeEach(() => {
    env = setupDoc()
  })
  afterEach(async () => {
    for (const c of env.clients) c.close()
    await env.srv.close()
  })

  it('removes a key locally and propagates the removal to a peer', async () => {
    await env.srv.store('docs').create('scene', { elements: { e1: { x: 1 }, e2: { x: 2 } } }, rules)
    const ha = env.makeClient('alice').store('docs').open('scene')
    const hb = env.makeClient('bob').store('docs').open('scene')
    await Promise.all([ha.ready, hb.ready])

    ha.delete(['elements', 'e1'])

    type Els = { elements: Record<string, unknown> }
    expect((ha.getSnapshot() as Els).elements.e1).toBeUndefined() // optimistic local removal
    await waitFor(() => (hb.getSnapshot() as Els).elements.e1 === undefined)
    expect((hb.getSnapshot() as Els).elements.e2).toEqual({ x: 2 })
  })

  it('a client delete MERGES with a concurrent peer edit to a sibling key (no clobber)', async () => {
    await env.srv.store('docs').create('scene', { elements: { e1: { x: 1 }, e2: { x: 2 } } }, rules)
    const ha = env.makeClient('alice').store('docs').open('scene')
    const hb = env.makeClient('bob').store('docs').open('scene')
    await Promise.all([ha.ready, hb.ready])

    // bob edits e2 while alice deletes e1 — the surgical delete must not clobber bob's edit
    hb.update({ elements: { e2: { x: 99 } } })
    ha.delete(['elements', 'e1'])

    type Els = { elements: Record<string, { x: number } | undefined> }
    await waitFor(() => {
      const a = ha.getSnapshot() as Els
      const b = hb.getSnapshot() as Els
      return a.elements.e1 === undefined && a.elements.e2?.x === 99 && b.elements.e1 === undefined && b.elements.e2?.x === 99
    })
  })
})

describe('store-sync (CRDT) — list + searchPrincipals', () => {
  const rw = { read: true, write: true }
  it('returns ResourceSummary rows with counts + timestamps, id-ASC by default', async () => {
    const store = syncStoreServer()
    store.create('b', {}, { alice: rw, bob: rw })
    store.create('a', {}, { alice: rw })
    const rows = await store.list()
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(rows.find((r) => r.id === 'b')?.principalCount).toBe(2)
    expect(rows.find((r) => r.id === 'a')?.createdAt).toBeGreaterThan(0)
    expect(rows.find((r) => r.id === 'a')?.updatedAt).toBeGreaterThan(0)
  })

  it('filters by idContains and by principals (OR/union)', async () => {
    const store = syncStoreServer()
    store.create('doc-1', {}, { alice: rw })
    store.create('doc-2', {}, { bob: rw })
    store.create('note-3', {}, { carol: rw })
    expect((await store.list({ idContains: 'doc' })).map((r) => r.id)).toEqual(['doc-1', 'doc-2'])
    expect((await store.list({ principals: ['alice', 'carol'] })).map((r) => r.id)).toEqual(['doc-1', 'note-3'])
    expect(await store.list({ principals: ['nobody'] })).toEqual([])
  })

  it('supports sort, limit, offset', async () => {
    const store = syncStoreServer()
    store.create('a', {}, {})
    store.create('b', {}, {})
    store.create('c', {}, {})
    expect((await store.list({ sort: { by: 'id', dir: 'desc' } })).map((r) => r.id)).toEqual(['c', 'b', 'a'])
    expect((await store.list({ limit: 2 })).map((r) => r.id)).toEqual(['a', 'b'])
    expect((await store.list({ offset: 1 })).map((r) => r.id)).toEqual(['b', 'c'])
  })

  it('searchPrincipals is global, distinct, ASC, substring-filtered', async () => {
    const store = syncStoreServer()
    store.create('x', {}, { alice: rw, bob: rw })
    store.create('y', {}, { alice: rw, carol: rw })
    expect(await store.searchPrincipals({})).toEqual(['alice', 'bob', 'carol'])
    expect(await store.searchPrincipals({ query: 'a' })).toEqual(['alice', 'carol'])
  })

  it('setAccess reindexes principals and delete drops from the index', async () => {
    const store = syncStoreServer()
    store.create('x', {}, { alice: rw })
    store.setAccess('x', { bob: rw })
    expect(await store.searchPrincipals({})).toEqual(['bob'])
    store.delete('x')
    expect(await store.searchPrincipals({})).toEqual([])
    expect(await store.list()).toEqual([])
  })

  it('a server co-write (open().set) bumps updatedAt', async () => {
    const store = syncStoreServer()
    store.create('d', { v: 0 }, {})
    await new Promise((r) => setTimeout(r, 5))
    const t0 = Date.now()
    store.open!('d').set({ v: 1 })
    expect((await store.list())[0]!.updatedAt).toBeGreaterThanOrEqual(t0)
  })
})

describe('store-sync (CRDT) — replica applyDelete', () => {
  it('notifies subscribers (so the handle re-reads deleted)', () => {
    const r = syncStoreClient().open('a')
    const cb = vi.fn()
    r.subscribe(cb)
    r.applyDelete()
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
