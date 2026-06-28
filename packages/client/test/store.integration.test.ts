import { defineContract } from '@super-line/core'
import { createSuperLineClient, type SuperLineClient } from '@super-line/client'
import { createSuperLineServer, type Conn } from '@super-line/server'
import { memoryStoreClient, memoryStoreServer } from '@super-line/store-memory'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const contract = defineContract({ roles: { user: { clientToServer: {} } } })
type Client = SuperLineClient<typeof contract, 'user'>

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function setup() {
  const loop = createLoopbackTransport()
  const serverConns: Conn[] = []
  const srv = createSuperLineServer(contract, {
    transports: [loop.server],
    authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid } }),
    identify: (conn) => (conn.ctx as { uid?: string }).uid,
    onConnection: (conn) => serverConns.push(conn),
    stores: { docs: memoryStoreServer() },
  })
  const clients: Client[] = []
  const makeClient = (uid: string): Client => {
    const cl = createSuperLineClient(contract, {
      transport: loop.client(),
      role: 'user',
      params: { uid },
      stores: { docs: memoryStoreClient() },
      reconnectBaseMs: 20,
      reconnectMaxMs: 60,
    })
    clients.push(cl)
    return cl
  }
  return { srv, makeClient, clients, serverConns }
}

describe('client store', () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })
  afterEach(async () => {
    for (const c of env.clients) c.close()
    await env.srv.close()
  })

  it('open returns a handle that catches up to the server snapshot', async () => {
    await env.srv.store('docs').create('d1', { v: 1 }, { alice: { read: true, write: true } })
    const h = env.makeClient('alice').store('docs').open('d1')
    await h.ready
    expect(h.getSnapshot()).toEqual({ v: 1 })
  })

  it("a write propagates to another subscriber's handle and fires its subscribe callback", async () => {
    await env.srv
      .store('docs')
      .create('d2', { v: 0 }, { alice: { read: true, write: true }, bob: { read: true, write: true } })
    const ha = env.makeClient('alice').store('docs').open('d2')
    const hb = env.makeClient('bob').store('docs').open('d2')
    await Promise.all([ha.ready, hb.ready])

    let fired = 0
    hb.subscribe(() => fired++)
    ha.set({ v: 2 })

    expect(ha.getSnapshot()).toEqual({ v: 2 }) // optimistic locally
    await waitFor(() => eq(hb.getSnapshot(), { v: 2 }))
    expect(fired).toBeGreaterThan(0)
  })

  it('read/write sugar round-trips', async () => {
    await env.srv.store('docs').create('d3', { v: 0 }, { alice: { read: true, write: true } })
    const docs = env.makeClient('alice').store('docs')
    await docs.write('d3', { v: 5 })
    expect(await docs.read('d3')).toEqual({ v: 5 })
  })

  it('open without read access rejects ready with FORBIDDEN', async () => {
    await env.srv.store('docs').create('d4', { v: 1 }, { alice: { read: true, write: true } })
    const h = env.makeClient('carol').store('docs').open('d4')
    await expect(h.ready).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('store(name) throws for an unconfigured store', () => {
    expect(() => env.makeClient('alice').store('nope')).toThrow(/not configured/)
  })

  it('a subscribed handle flips deleted=true and fires subscribe when the server deletes', async () => {
    await env.srv.store('docs').create('ddel', { v: 1 }, { alice: { read: true, write: true } })
    const h = env.makeClient('alice').store('docs').open('ddel')
    await h.ready
    expect(h.deleted).toBe(false)
    let fired = 0
    h.subscribe(() => fired++)

    await env.srv.store('docs').delete('ddel')

    await waitFor(() => h.deleted)
    expect(fired).toBeGreaterThan(0)
  })

  it('re-snapshots an open Resource after a reconnect', async () => {
    await env.srv.store('docs').create('d5', { v: 1 }, { alice: { read: true, write: true } })
    const h = env.makeClient('alice').store('docs').open('d5')
    await h.ready
    expect(h.getSnapshot()).toEqual({ v: 1 })

    // drop the server side and change the canonical value while disconnected
    env.serverConns[env.serverConns.length - 1]?.terminate()
    await env.srv.store('docs').write('d5', { v: 99 })

    // the client reconnects and re-opens, catching up to the new value
    await waitFor(() => eq(h.getSnapshot(), { v: 99 }))
    expect(h.getSnapshot()).toEqual({ v: 99 })
  })
})
