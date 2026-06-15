import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { MemoryBus, createInMemoryAdapter } from '@super-line/server'
import { createHarness, waitFor } from './harness.js'

const contract = defineContract({
  shared: {
    clientToServer: { hello: { input: z.object({}), output: z.object({ ok: z.boolean() }) } },
    serverToClient: { notice: { payload: z.object({ text: z.string() }) } },
  },
  roles: { user: {} },
})

function auth(req: { url?: string }) {
  const u = new URL(req.url ?? '', 'http://localhost')
  return { role: 'user' as const, ctx: { userId: u.searchParams.get('uid') ?? 'anon' } }
}
const identify = (conn: { ctx: unknown }) => (conn.ctx as { userId: string }).userId

const h = createHarness()
afterEach(() => h.dispose())

async function twoNodes() {
  const bus = new MemoryBus()
  const opts = { authenticate: auth, identify }
  const n1 = await h.server(contract, { ...opts, adapter: createInMemoryAdapter(bus) })
  const n2 = await h.server(contract, { ...opts, adapter: createInMemoryAdapter(bus) })
  for (const n of [n1, n2]) n.srv.implement({ shared: { hello: async () => ({ ok: true }) }, user: {} })
  return { n1, n2 }
}

describe('targeted cross-node send (slice 5)', () => {
  it('toConn(id).emit reaches a connection held by another node', async () => {
    const { n1, n2 } = await twoNodes()
    const ca = h.client(contract, { url: n1.url, role: 'user', params: { uid: 'u1' } })
    const got: Array<{ text: string }> = []
    ca.on('notice', (m) => got.push(m))
    await ca.hello({})
    await waitFor(() => n1.srv.local.connections.length === 1)

    const idA = n1.srv.local.connections[0]!.id
    n2.srv.toConn(idA).emit('notice', { text: 'hi' }) // from the other node
    await waitFor(() => got.length === 1)
    expect(got[0]).toEqual({ text: 'hi' })
  })

  it('toUser(uid).emit fans out to every device across nodes', async () => {
    const { n1, n2 } = await twoNodes()
    const c1 = h.client(contract, { url: n1.url, role: 'user', params: { uid: 'u9' } })
    const c2 = h.client(contract, { url: n2.url, role: 'user', params: { uid: 'u9' } })
    const g1: unknown[] = []
    const g2: unknown[] = []
    c1.on('notice', (m) => g1.push(m))
    c2.on('notice', (m) => g2.push(m))
    await Promise.all([c1.hello({}), c2.hello({})])
    await waitFor(() => n1.srv.local.connections.length === 1 && n2.srv.local.connections.length === 1)

    n1.srv.toUser('u9').emit('notice', { text: 'all' })
    await waitFor(() => g1.length === 1 && g2.length === 1)
    expect(g1[0]).toEqual({ text: 'all' })
    expect(g2[0]).toEqual({ text: 'all' })
  })

  it('toConn(id).close() disconnects a connection on another node', async () => {
    const { n1, n2 } = await twoNodes()
    const ca = h.client(contract, { url: n1.url, role: 'user', params: { uid: 'u1' }, reconnect: false })
    await ca.hello({})
    await waitFor(() => n1.srv.local.connections.length === 1)

    const idA = n1.srv.local.connections[0]!.id
    n2.srv.toConn(idA).close()
    await waitFor(() => n1.srv.local.connections.length === 0)
  })
})
