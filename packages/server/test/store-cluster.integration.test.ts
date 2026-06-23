import { defineContract, type ClientTransport, type ServerStore } from '@super-line/core'
import { createSuperLineClient } from '@super-line/client'
import { MemoryBus, createInMemoryAdapter, createSuperLineServer } from '@super-line/server'
import { memoryStoreClient, memoryStoreServer } from '@super-line/store-memory'
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

function twoNodes(storeFactory: () => ServerStore) {
  const bus = new MemoryBus()
  const node = () => {
    const loop = createLoopbackTransport()
    const srv = createSuperLineServer(contract, {
      transports: [loop.server],
      adapter: createInMemoryAdapter(bus),
      authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid } }),
      identify: (conn) => (conn.ctx as { uid?: string }).uid,
      stores: { docs: storeFactory() },
    })
    cleanups.push(() => srv.close())
    return { srv, transport: loop.client() }
  }
  return { a: node(), b: node() }
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

describe('store — cross-node', () => {
  it('a write on node A converges node B (both the subscriber handle and B’s store replica)', async () => {
    const { a, b } = twoNodes(() => memoryStoreServer())
    // creates are node-local for the memory store, so seed both nodes
    await a.srv.store('docs').create('d', { v: 0 }, rules)
    await b.srv.store('docs').create('d', { v: 0 }, rules)

    const clientA = client(a.transport, 'alice')
    const clientB = client(b.transport, 'bob')
    const hb = clientB.store('docs').open('d')
    await hb.ready
    expect(hb.getSnapshot()).toEqual({ v: 0 })

    await clientA.store('docs').write('d', { v: 1 })

    await waitFor(() => eq(hb.getSnapshot(), { v: 1 })) // fan-out reaches B's subscriber
    expect((await b.srv.store('docs').read('d'))?.data).toEqual({ v: 1 }) // B's replica converged (relay-apply)
  })

  it('a self-mode store is not relay-applied (it owns its own cross-node sync)', async () => {
    const { a, b } = twoNodes(() => ({ ...memoryStoreServer(), clustering: 'self' as const }))
    await a.srv.store('docs').create('d', { v: 0 }, rules)
    await b.srv.store('docs').create('d', { v: 0 }, rules)

    const clientA = client(a.transport, 'alice')
    await clientA.store('docs').write('d', { v: 1 })
    await sleep(60)

    expect((await a.srv.store('docs').read('d'))?.data).toEqual({ v: 1 }) // local write applied
    expect((await b.srv.store('docs').read('d'))?.data).toEqual({ v: 0 }) // NOT relay-applied (self-mode)
  })
})
