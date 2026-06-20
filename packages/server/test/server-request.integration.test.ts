import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, SuperLineError } from '@super-line/core'
import { MemoryBus, createInMemoryAdapter } from '@super-line/server'
import { createHarness, waitFor } from './harness.js'

const contract = defineContract({
  shared: {
    clientToServer: { hello: { input: z.object({}), output: z.object({ ok: z.boolean() }) } },
    serverToClient: {
      confirm: { input: z.object({ q: z.string() }), output: z.object({ ok: z.boolean() }) },
    },
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

async function server(adapter?: ReturnType<typeof createInMemoryAdapter>) {
  const n = await h.server(contract, { authenticate: auth, identify, ...(adapter ? { adapter } : {}) })
  n.srv.implement({ shared: { hello: async () => ({ ok: true }) }, user: {} })
  return n
}

describe('server→client request (slice 6)', () => {
  it('requests a client and resolves with typed output', async () => {
    const { srv, url } = await server()
    const client = h.client(contract, { url, role: 'user', params: { uid: 'u1' } })
    client.implement({ confirm: async ({ q }) => ({ ok: q === 'ready?' }) })
    await client.hello({})
    await waitFor(() => srv.local.connections.length === 1)
    const id = srv.local.connections[0]!.id

    expect(await srv.toConn(id).request('confirm', { q: 'ready?' })).toEqual({ ok: true })
    expect(await srv.toConn(id).request('confirm', { q: 'nope' })).toEqual({ ok: false })
  })

  it('relays a typed SuperLineError thrown by the client handler', async () => {
    const { srv, url } = await server()
    const client = h.client(contract, { url, role: 'user', params: { uid: 'u1' } })
    client.implement({
      confirm: async () => {
        throw new SuperLineError('FORBIDDEN', 'no', { why: 'x' })
      },
    })
    await client.hello({})
    await waitFor(() => srv.local.connections.length === 1)
    const id = srv.local.connections[0]!.id

    await expect(srv.toConn(id).request('confirm', { q: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      data: { why: 'x' },
    })
  })

  it('times out when the client never answers', async () => {
    const { srv, url } = await server()
    const client = h.client(contract, { url, role: 'user', params: { uid: 'u1' } })
    client.implement({ confirm: () => new Promise(() => {}) }) // never resolves
    await client.hello({})
    await waitFor(() => srv.local.connections.length === 1)
    const id = srv.local.connections[0]!.id

    await expect(
      srv.toConn(id).request('confirm', { q: 'x' }, { timeout: 150 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('rejects with TIMEOUT when no live node owns the connection id', async () => {
    const { srv } = await server()
    await expect(
      srv.toConn('ghost').request('confirm', { q: 'x' }, { timeout: 200 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('routes a request to a client held by another node', async () => {
    const bus = new MemoryBus()
    const n1 = await server(createInMemoryAdapter(bus))
    const n2 = await server(createInMemoryAdapter(bus))
    const client = h.client(contract, { url: n1.url, role: 'user', params: { uid: 'u1' } })
    client.implement({ confirm: async ({ q }) => ({ ok: q === 'go' }) })
    await client.hello({})
    await waitFor(() => n1.srv.local.connections.length === 1)
    const id = n1.srv.local.connections[0]!.id

    expect(await n2.srv.toConn(id).request('confirm', { q: 'go' })).toEqual({ ok: true })
  })
})
