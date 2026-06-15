import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, type Adapter } from '@super-line/core'
import { MemoryBus, createInMemoryAdapter } from '@super-line/server'
import { createHarness, waitFor } from './harness.js'

const contract = defineContract({
  shared: {
    clientToServer: {
      joinRoom: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
    },
  },
  roles: { user: {}, agent: {} },
})

function auth(req: { url?: string }) {
  const u = new URL(req.url ?? '', 'http://localhost')
  const role = u.searchParams.get('role') as 'user' | 'agent'
  return { role, ctx: { userId: u.searchParams.get('uid') ?? 'anon', plan: 'pro' } }
}

const identify = (conn: { ctx: unknown }) => (conn.ctx as { userId: string }).userId
const describeConn = (conn: { ctx: unknown }) => ({ plan: (conn.ctx as { plan: string }).plan })

const h = createHarness()
afterEach(() => h.dispose())

describe('presence registry + cluster surface (slice 3)', () => {
  it('reflects connections, identity, describeConn fields, and counts', async () => {
    const { srv, url } = await h.server(contract, { authenticate: auth, identify, describeConn })
    srv.implement({ shared: { joinRoom: async () => ({ ok: true }) }, user: {}, agent: {} })

    h.client(contract, { url, role: 'user', params: { uid: 'u1' } })
    h.client(contract, { url, role: 'agent', params: { uid: 'u2' } })
    await waitFor(() => srv.local.connections.length === 2)

    expect(await srv.cluster.count()).toBe(2)
    const all = await srv.cluster.connections()
    expect(all).toHaveLength(2)
    const u1 = all.find((d) => d.userId === 'u1')!
    expect(u1.role).toBe('user')
    expect(u1.nodeId).toBe(srv.nodeId)
    expect(u1.plan).toBe('pro') // describeConn
    expect(u1.rooms).toEqual([])
    expect(u1.connectedAt).toBeGreaterThan(0)
    expect('lastPongAt' in u1).toBe(false) // node-local only, never in the registry

    expect(await srv.isOnline('u1')).toBe(true)
    expect(await srv.isOnline('nobody')).toBe(false)
    expect(await srv.cluster.byUser('u1')).toHaveLength(1)
  })

  it('tracks room membership in the registry', async () => {
    const { srv, url } = await h.server(contract, { authenticate: auth, identify, describeConn })
    srv.implement({
      shared: { joinRoom: async ({ room }, _c, conn) => (srv.room(room).add(conn), { ok: true }) },
      user: {},
      agent: {},
    })

    const c1 = h.client(contract, { url, role: 'user', params: { uid: 'u1' } })
    await c1.joinRoom({ room: 'lobby' })
    await waitFor(() => srv.local.rooms.includes('lobby'))

    const members = await srv.cluster.room('lobby')
    expect(members[0]?.userId).toBe('u1')
    expect(members[0]?.rooms).toContain('lobby')
  })

  it('aggregates across nodes sharing a bus (topology)', async () => {
    const bus = new MemoryBus()
    const a = await h.server(contract, {
      authenticate: auth,
      identify,
      adapter: createInMemoryAdapter(bus),
    })
    const b = await h.server(contract, {
      authenticate: auth,
      identify,
      adapter: createInMemoryAdapter(bus),
    })
    a.srv.implement({ shared: { joinRoom: async () => ({ ok: true }) }, user: {}, agent: {} })
    b.srv.implement({ shared: { joinRoom: async () => ({ ok: true }) }, user: {}, agent: {} })

    h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    h.client(contract, { url: b.url, role: 'user', params: { uid: 'u2' } })

    await waitFor(() => a.srv.local.connections.length === 1 && b.srv.local.connections.length === 1)
    expect(await a.srv.cluster.count()).toBe(2)
    expect(await b.srv.cluster.count()).toBe(2) // both nodes see the whole cluster

    const topo = await a.srv.cluster.topology()
    expect(topo).toHaveLength(2)
    expect(new Set(topo.map((n) => n.nodeId))).toEqual(new Set([a.srv.nodeId, b.srv.nodeId]))
    expect(topo.every((n) => n.connections === 1 && n.alive)).toBe(true)
  })

  it('no identify => byUser/isOnline empty but connections still work', async () => {
    const { srv, url } = await h.server(contract, { authenticate: auth })
    srv.implement({ shared: { joinRoom: async () => ({ ok: true }) }, user: {}, agent: {} })
    h.client(contract, { url, role: 'user', params: { uid: 'u1' } })
    await waitFor(() => srv.local.connections.length === 1)

    expect(await srv.isOnline('u1')).toBe(false)
    expect(await srv.cluster.byUser('u1')).toHaveLength(0)
    expect(await srv.cluster.connections()).toHaveLength(1)
  })

  it('rejects cluster queries when the adapter has no presence support', async () => {
    const bare: Adapter = {
      subscribe() {},
      unsubscribe() {},
      publish() {},
      onMessage() {},
    }
    const { srv } = await h.server(contract, { authenticate: auth, adapter: bare })
    await expect(srv.cluster.connections()).rejects.toThrow(/presence/i)
  })
})
