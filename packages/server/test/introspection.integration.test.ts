import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createHarness, waitFor } from './harness.js'

const contract = defineContract({
  shared: {
    clientToServer: {
      joinRoom: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
    },
    serverToClient: {
      feed: { payload: z.object({ n: z.number() }), subscribe: true },
    },
  },
  roles: {
    user: {},
    agent: {},
  },
})

function authenticate(h: { query: Record<string, string> }) {
  const role = h.query.role as 'user' | 'agent'
  return { role, ctx: { role } }
}

const h = createHarness()
afterEach(() => h.dispose())

describe('local introspection (slice 1)', () => {
  it('exposes a stable nodeId', async () => {
    const { srv } = await h.server(contract, { authenticate })
    expect(typeof srv.nodeId).toBe('string')
    expect(srv.nodeId.length).toBeGreaterThan(0)
    expect(srv.nodeId).toBe(srv.nodeId)
  })

  it('lists all local connections, filterable by role and id, with metadata', async () => {
    const before = Date.now()
    const { srv, url } = await h.server(contract, { authenticate })
    srv.implement({
      shared: { joinRoom: async ({ room }, _ctx, conn) => (srv.room(room).add(conn), { ok: true }) },
      user: {},
      agent: {},
    })

    const u1 = h.client(contract, { url, role: 'user' })
    const u2 = h.client(contract, { url, role: 'user' })
    const a1 = h.client(contract, { url, role: 'agent' })
    await Promise.all([u1.joinRoom({ room: 'lobby' }), u2.joinRoom({ room: 'lobby' }), a1.joinRoom({ room: 'lobby' })])
    await waitFor(() => srv.local.connections.length === 3)

    const conns = srv.local.connections
    expect(conns.filter((c) => c.role === 'user')).toHaveLength(2)
    expect(conns.filter((c) => c.role === 'agent')).toHaveLength(1)

    const ids = conns.map((c) => c.id)
    expect(new Set(ids).size).toBe(3) // unique
    const byId = conns.find((c) => c.id === ids[0])
    expect(byId).toBe(conns[0])

    for (const c of conns) {
      expect(c.connectedAt).toBeGreaterThanOrEqual(before)
      expect(c.connectedAt).toBeLessThanOrEqual(Date.now())
    }
  })

  it('reports rooms, room membership, and topics for this node', async () => {
    const { srv, url } = await h.server(contract, { authenticate })
    srv.implement({
      shared: { joinRoom: async ({ room }, _ctx, conn) => (srv.room(room).add(conn), { ok: true }) },
      user: {},
      agent: {},
    })

    const u1 = h.client(contract, { url, role: 'user' })
    await u1.joinRoom({ room: 'lobby' })
    await waitFor(() => srv.local.rooms.includes('lobby'))

    expect(srv.local.rooms).toEqual(['lobby'])
    expect(srv.room('lobby').size).toBe(1)
    expect(srv.room('lobby').connections).toHaveLength(1)
    expect(srv.room('lobby').connections[0]?.role).toBe('user')

    const sub = u1.subscribe('feed', () => {})
    await sub.ready
    await waitFor(() => srv.local.topics.includes('feed'))
    expect(srv.local.topics).toEqual(['feed'])
  })

  it('drops connections from the local view on disconnect', async () => {
    const { srv, url } = await h.server(contract, { authenticate })
    srv.implement({ shared: { joinRoom: async () => ({ ok: true }) }, user: {}, agent: {} })

    const u1 = h.client(contract, { url, role: 'user' })
    await u1.joinRoom({ room: 'x' })
    await waitFor(() => srv.local.connections.length === 1)

    u1.close()
    await waitFor(() => srv.local.connections.length === 0)
  })
})
