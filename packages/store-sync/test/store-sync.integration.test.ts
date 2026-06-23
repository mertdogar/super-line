import { defineContract } from '@super-line/core'
import { createSuperLineClient, type SuperLineClient } from '@super-line/client'
import { createSuperLineServer } from '@super-line/server'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
