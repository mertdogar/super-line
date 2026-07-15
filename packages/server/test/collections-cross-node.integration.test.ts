import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, type TapEvent } from '@super-line/core'
import { createInMemoryAdapter, createSuperLineServer, MemoryBus, type SuperLinePlugin } from '@super-line/server'
import { createSuperLineClient, type SuperLineClient } from '@super-line/client'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { memoryCollections } from '@super-line/collections-memory'
import { crdtCollectionsClient, crdtMemoryCollections } from '@super-line/collections-crdt-memory'

// Characterization of the CROSS-NODE collection paths — the only part of collections with no other coverage.
// Both families are `relay` here: every node keeps its own replica and the batch/delta travels over the Adapter.
// These pin CURRENT behaviour ahead of the Collection-runtime extraction; they are documentation, not a wishlist.
//
// The two families deliver locally by OPPOSITE strategies, and that is the thing most at risk in a refactor:
//   rows — deliver at the SOURCE (store.apply → onChange → route), then DROP the looped-back copy.
//   crdt — do NOT deliver on the local onChange at all; publish, and let the Adapter's loopback come back and
//          fan out (index.ts forwards raw to local subscribers BEFORE the echo-break check). Loopback IS delivery.

const contract = defineContract({
  collections: {
    messages: { schema: z.object({ id: z.string(), text: z.string() }), key: 'id' },
    scenes: { schema: z.object({ title: z.string().optional() }), crdt: { mode: 'document' } },
  },
  roles: { user: { clientToServer: {} } },
})

type Client = SuperLineClient<typeof contract, 'user'>
type Scene = { title?: string }

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await tick(5)
  }
}

const open = { read: () => undefined, write: () => true }

const nodes: Array<{ close: () => Promise<void> }> = []
const clients: Client[] = []

function node(bus: MemoryBus) {
  const loop = createLoopbackTransport()
  const taps: TapEvent[] = []
  const srv = createSuperLineServer(contract, {
    transports: [loop.server],
    adapter: createInMemoryAdapter(bus),
    authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid ?? 'anon' } }),
    identify: (conn) => (conn.ctx as { uid: string }).uid,
    collections: memoryCollections(), // node-local replica: relay re-applies the batch on every node
    crdtCollections: crdtMemoryCollections(),
    plugins: [{ name: 'tap', onEvent: (e) => taps.push(e) } satisfies SuperLinePlugin],
    policies: {
      messages: open,
      scenes: { read: () => true, write: () => true },
    },
  })
  nodes.push({ close: () => srv.close() })
  const client = (uid: string): Client => {
    const cl = createSuperLineClient(contract, {
      transport: loop.client(),
      role: 'user',
      params: { uid },
      crdtCollections: crdtCollectionsClient(),
    })
    clients.push(cl)
    return cl
  }
  return { srv, client, taps }
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const n of nodes.splice(0)) await n.close()
})

describe('collections across nodes — row relay', () => {
  it('a batch written on one node reaches a subscriber on the other', async () => {
    const bus = new MemoryBus()
    const a = node(bus)
    const b = node(bus)

    const sub = b.client('bob').collection('messages').subscribe({})
    await sub.ready

    await a.client('alice').collection('messages').insert({ id: 'm1', text: 'hi' })

    await waitFor(() => sub.rows().length === 1)
    expect(sub.rows()).toMatchObject([{ id: 'm1', text: 'hi' }])
    // relay means node B re-applied the batch into its OWN replica, not just forwarded a frame
    expect(await b.srv.collection('messages').read('m1')).toMatchObject({ text: 'hi' })
  })

  it('the origin node delivers its own write exactly once — the looped-back batch is dropped', async () => {
    const bus = new MemoryBus()
    const a = node(bus)
    node(bus) // a second node, so the batch really does go out over the bus and loop back

    const ca = a.client('alice')
    const sub = ca.collection('messages').subscribe({})
    await sub.ready

    await ca.collection('messages').insert({ id: 'm1', text: 'hi' })
    await waitFor(() => sub.rows().length === 1)
    await tick(40) // give the loopback every chance to arrive and be (wrongly) re-applied

    // rows route at the SOURCE; `env.nd === instanceId` drops the echo. A regression here fires twice.
    expect(a.taps.filter((e) => e.type === 'collection.change')).toHaveLength(1)
    expect(sub.rows()).toHaveLength(1)
  })

  it('a server co-write on one node reaches a client subscribed on the other', async () => {
    const bus = new MemoryBus()
    const a = node(bus)
    const b = node(bus)

    const sub = b.client('bob').collection('messages').subscribe({})
    await sub.ready

    await a.srv.collection('messages').insert({ id: 'm1', text: 'from-server' })

    await waitFor(() => sub.rows().length === 1)
    expect(sub.rows()).toMatchObject([{ id: 'm1', text: 'from-server' }])
  })
})

describe('collections across nodes — CRDT relay', () => {
  // creates are node-local for a relay backend (index.ts drops a delta for a doc this node has never seen),
  // so a two-node CRDT test seeds the document on both nodes.
  async function seed(...ns: Array<{ srv: { collection: (n: 'scenes') => { create: (id: string, d: Scene) => Promise<void> } } }>) {
    for (const n of ns) await n.srv.collection('scenes').create('s1', {})
  }

  it('a delta written on one node reaches a client on the other', async () => {
    const bus = new MemoryBus()
    const a = node(bus)
    const b = node(bus)
    await seed(a, b)

    const da = a.client('alice').collection('scenes').open('s1')
    const db = b.client('bob').collection('scenes').open('s1')
    await Promise.all([da.ready, db.ready])

    da.update({ title: 'from-a' })

    await waitFor(() => (db.getSnapshot() as Scene)?.title === 'from-a')
    expect((db.getSnapshot() as Scene).title).toBe('from-a')
  })

  it('a second client on the ORIGIN node receives the delta — local delivery rides the adapter loopback', async () => {
    const bus = new MemoryBus()
    const a = node(bus)
    node(bus)
    await seed(a)

    // both clients are on node A. CRDT does not deliver on its own onChange — it publishes, and the loopback
    // is what fans out locally. A cluster port that filtered own-messages would break exactly this.
    const d1 = a.client('alice').collection('scenes').open('s1')
    const d2 = a.client('carol').collection('scenes').open('s1')
    await Promise.all([d1.ready, d2.ready])

    d1.update({ title: 'from-alice' })

    await waitFor(() => (d2.getSnapshot() as Scene)?.title === 'from-alice')
    expect((d2.getSnapshot() as Scene).title).toBe('from-alice')
  })

  it('the receiving node applies a relayed delta without re-publishing it — the `relaying` guard holds', async () => {
    const bus = new MemoryBus()
    const a = node(bus)
    const b = node(bus)
    await seed(a, b)

    const da = a.client('alice').collection('scenes').open('s1')
    const db = b.client('bob').collection('scenes').open('s1')
    await Promise.all([da.ready, db.ready])

    da.update({ title: 'x' })
    await waitFor(() => (db.getSnapshot() as Scene)?.title === 'x')
    await tick(50)

    // B's store fired onChange while applying the relayed delta; `relaying` must suppress the re-publish.
    // Without it each node re-publishes the other's delta forever — an echo storm, not a failed assertion.
    expect(a.taps.filter((e) => e.type === 'crdt.change')).toHaveLength(1)
    expect(b.taps.filter((e) => e.type === 'crdt.change')).toHaveLength(0)
  })

  it('a server-side delete fans out to clients on every node', async () => {
    const bus = new MemoryBus()
    const a = node(bus)
    const b = node(bus)
    await seed(a, b)

    const db = b.client('bob').collection('scenes').open('s1')
    await db.ready

    await a.srv.collection('scenes').delete('s1')

    await waitFor(() => db.deleted)
    expect(db.deleted).toBe(true)
  })
})
