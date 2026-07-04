import {
  defineContract,
  jsonSerializer,
  type ClientTransport,
  type Resource,
  type ServerFrame,
  type ServerStore,
  type SDeleteFrame,
  type StoreChange,
} from '@super-line/core'
import { createSuperLineClient } from '@super-line/client'
import { MemoryBus, createInMemoryAdapter, createSuperLineServer } from '@super-line/server'
import { memoryStoreClient } from '@super-line/store-memory'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { afterEach, describe, expect, it } from 'vitest'

const contract = defineContract({ roles: { user: { clientToServer: {} } } })
const rules = { alice: { read: true, write: true }, bob: { read: true, write: true } }
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await sleep(5)
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

/**
 * A minimal `clustering: 'self'` store. `apply`/`delete` just persist (in the real pglite store they write
 * the central DB); cross-node propagation is owned by the backend. `feed`/`feedDelete` simulate what the
 * backend's change feed (Electric `live.changes`) drives on each node — firing onChange/onDelete, which is
 * exactly what the server must fan to LOCAL connections only.
 */
function selfStore(): ServerStore & { feed(c: StoreChange): void; feedDelete(id: string): void } {
  const data = new Map<string, Resource>()
  const changeCbs = new Set<(c: StoreChange) => void>()
  const deleteCbs = new Set<(id: string) => void>()
  return {
    clustering: 'self',
    model: 'lww',
    read: (id) => data.get(id),
    create: (id, d, accessRules) => {
      data.set(id, { id, accessRules, data: d })
    },
    apply: (c) => {
      const r = data.get(c.id)
      if (r) r.data = c.update
    },
    setAccess: (id, accessRules) => {
      const r = data.get(id)
      if (r) r.accessRules = accessRules
    },
    delete: (id) => {
      data.delete(id)
    },
    list: () => [...data.values()].map((r) => ({ id: r.id, principalCount: Object.keys(r.accessRules).length, createdAt: 0, updatedAt: 0 })),
    searchPrincipals: () => [],
    onChange: (cb) => {
      changeCbs.add(cb)
      return () => changeCbs.delete(cb)
    },
    onDelete: (cb) => {
      deleteCbs.add(cb)
      return () => deleteCbs.delete(cb)
    },
    feed: (c) => {
      const r = data.get(c.id)
      if (r) r.data = c.update
      for (const cb of changeCbs) cb(c)
    },
    feedDelete: (id) => {
      data.delete(id)
      for (const cb of deleteCbs) cb(id)
    },
  }
}

function node(bus: MemoryBus, store: ServerStore) {
  const loop = createLoopbackTransport()
  const srv = createSuperLineServer(contract, {
    transports: [loop.server],
    adapter: createInMemoryAdapter(bus),
    authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid } }),
    identify: (conn) => (conn.ctx as { uid?: string }).uid,
    stores: { docs: store },
  })
  cleanups.push(() => srv.close())
  return { srv, transport: loop.client() }
}

function client(transport: ClientTransport, uid: string) {
  const cl = createSuperLineClient(contract, {
    transport,
    role: 'user',
    params: { uid },
    stores: { docs: memoryStoreClient() },
  })
  cleanups.push(() => cl.close())
  return cl
}

describe('store — self clustering', () => {
  it('a backend change fans to a local subscriber', async () => {
    const store = selfStore()
    const { srv, transport } = node(new MemoryBus(), store)
    await srv.store('docs').create('d', { v: 0 }, rules)
    const h = client(transport, 'alice').store('docs').open('d')
    await h.ready
    expect(h.getSnapshot()).toEqual({ v: 0 })

    store.feed({ id: 'd', update: { v: 1 }, origin: 'someone' })

    await waitFor(() => eq(h.getSnapshot(), { v: 1 }))
  })

  it('a backend delete fans to a local subscriber via onDelete → sdel', async () => {
    const store = selfStore()
    const { srv, transport } = node(new MemoryBus(), store)
    await srv.store('docs').create('d', { v: 1 }, rules)
    const h = client(transport, 'alice').store('docs').open('d')
    await h.ready
    expect(h.deleted).toBe(false)
    let fired = 0
    h.subscribe(() => fired++)

    store.feedDelete('d')

    await waitFor(() => h.deleted)
    expect(fired).toBeGreaterThan(0)
  })

  it('a backend change does NOT cross the adapter to another node', async () => {
    const bus = new MemoryBus()
    const storeA = selfStore()
    const storeB = selfStore()
    const a = node(bus, storeA)
    const b = node(bus, storeB)
    await a.srv.store('docs').create('d', { v: 0 }, rules)
    await b.srv.store('docs').create('d', { v: 0 }, rules)

    const hb = client(b.transport, 'bob').store('docs').open('d')
    await hb.ready

    storeA.feed({ id: 'd', update: { v: 1 }, origin: 'x' }) // fires on node A only

    await sleep(80)
    expect(hb.getSnapshot()).toEqual({ v: 0 }) // B's subscriber did NOT get A's change (self = no adapter fan-out)
  })

  it('a server-API delete on a self store does NOT publish sdel over the adapter', async () => {
    const bus = new MemoryBus()
    const a = node(bus, selfStore())
    const b = node(bus, selfStore())
    await a.srv.store('docs').create('d', { v: 0 }, rules)
    await b.srv.store('docs').create('d', { v: 0 }, rules)

    const frames: ServerFrame[] = []
    const spy: ClientTransport = {
      connect: (params, hooks) =>
        b.transport.connect(params, {
          ...hooks,
          onMessage(bytes) {
            try {
              frames.push(jsonSerializer.decode(bytes) as ServerFrame)
            } catch {
              /* ignore */
            }
            hooks.onMessage(bytes)
          },
        }),
    }
    const clientB = createSuperLineClient(contract, {
      transport: spy,
      role: 'user',
      params: { uid: 'bob' },
      stores: { docs: memoryStoreClient() },
    })
    cleanups.push(() => clientB.close())
    const hb = clientB.store('docs').open('d')
    await hb.ready

    await a.srv.store('docs').delete('d')

    await sleep(80)
    expect(frames.some((f) => f.t === 'sdel' && (f as SDeleteFrame).id === 'd')).toBe(false)
  })
})
