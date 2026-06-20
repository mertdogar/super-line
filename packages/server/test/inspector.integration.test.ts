import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, INSPECTOR_SUBPROTOCOL } from '@super-line/core'
import type { InspectedContract, Schema } from '@super-line/core'
import { MemoryBus, createInMemoryAdapter } from '@super-line/server'
import { connectInspector, createHarness, waitFor } from './harness.js'

const contract = defineContract({
  roles: {
    user: { clientToServer: { ping: { input: z.void(), output: z.number() } } },
    agent: {},
  },
})

function authenticate(req: { url?: string }) {
  const role = new URL(req.url ?? '', 'http://localhost').searchParams.get('role') as 'user' | 'agent'
  return { role, ctx: { role } }
}

const h = createHarness()
afterEach(() => h.dispose())

describe('inspector connection (slice 2)', () => {
  it('echoes the reserved subprotocol and bypasses authenticate', async () => {
    let authCalls = 0
    const { url } = await h.server(contract, {
      authenticate: (req) => {
        authCalls++
        return authenticate(req)
      },
      inspector: true,
    })
    const insp = await connectInspector(url)
    expect(insp.protocol).toBe(INSPECTOR_SUBPROTOCOL)
    expect(authCalls).toBe(0)
    insp.close()
  })

  it('serves getNode / listConnections / getTopology, excluding itself', async () => {
    const { srv, url } = await h.server(contract, { authenticate, inspector: true })
    srv.implement({ user: { ping: async () => 1 }, agent: {} })

    const u1 = h.client(contract, { url, role: 'user' })
    const u2 = h.client(contract, { url, role: 'user' })
    await Promise.all([u1.ping(), u2.ping()])
    await waitFor(() => srv.local.connections.length === 2)

    const insp = await connectInspector(url)

    const node = (await insp.request('getNode')) as { nodeId: string; rooms: string[]; topics: string[] }
    expect(node.nodeId).toBe(srv.nodeId)
    expect(node.rooms).toEqual([])
    expect(node.topics).toEqual([])

    const conns = (await insp.request('listConnections')) as Array<{ role: string }>
    expect(conns).toHaveLength(2) // the inspector itself is excluded from presence
    expect(conns.every((cn) => cn.role === 'user')).toBe(true)

    const topo = (await insp.request('getTopology')) as Array<{ nodeId: string; connections: number }>
    expect(topo).toHaveLength(1)
    expect(topo[0]?.nodeId).toBe(srv.nodeId)
    expect(topo[0]?.connections).toBe(2) // inspector not counted

    // observer-invisible in the server's own local view too
    expect(srv.local.connections).toHaveLength(2)

    insp.close()
  })

  it('returns NOT_FOUND for an unknown inspector method', async () => {
    const { url } = await h.server(contract, { authenticate, inspector: true })
    const insp = await connectInspector(url)
    await expect(insp.request('bogus')).rejects.toThrow('NOT_FOUND')
    insp.close()
  })

  it('rejects the inspector handshake when disabled', async () => {
    const { url } = await h.server(contract, { authenticate }) // inspector off
    // the server doesn't echo the reserved subprotocol, so the ws client fails the handshake
    await expect(connectInspector(url)).rejects.toThrow(/subprotocol/i)
  })
})

// a Standard Schema with an unknown vendor: no converter exists -> structure-only for that message
const mystery = {
  '~standard': { version: 1, vendor: 'mystery', validate: (value: unknown) => ({ value }) },
} as unknown as Schema

const richContract = defineContract({
  roles: {
    user: {
      clientToServer: {
        say: { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) },
        raw: { input: mystery, output: mystery },
      },
      serverToClient: {
        feed: { payload: z.object({ n: z.number() }), subscribe: true },
      },
    },
  },
})

describe('inspector getContract (slice 3)', () => {
  it('returns structure + best-effort JSON Schema, falling back to structure-only per message', async () => {
    const { url } = await h.server(richContract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      inspector: true,
    })
    const insp = await connectInspector(url)
    const got = (await insp.request('getContract')) as InspectedContract

    const cts = got.roles.user?.clientToServer ?? []
    const say = cts.find((m) => m.name === 'say')
    expect(say?.flavor).toBe('request')
    const sayInput = say?.input as { type?: string; properties?: Record<string, unknown> } | undefined
    expect(sayInput?.type).toBe('object') // zod -> JSON Schema
    expect(sayInput?.properties?.text).toBeDefined()
    expect(say?.output).toMatchObject({ type: 'object' })

    const raw = cts.find((m) => m.name === 'raw')
    expect(raw?.flavor).toBe('request')
    expect(raw?.input).toBeUndefined() // unknown vendor -> structure only
    expect(raw?.output).toBeUndefined()

    const feed = (got.roles.user?.serverToClient ?? []).find((m) => m.name === 'feed')
    expect(feed?.flavor).toBe('topic')
    expect(feed?.payload).toMatchObject({ type: 'object' })

    insp.close()
  })
})

const ctxContract = defineContract({
  roles: { user: { clientToServer: { ping: { input: z.void(), output: z.number() } } } },
})

interface ConnViewResult {
  descriptor: { id: string; role: string }
  ctx?: Record<string, unknown>
  data?: Record<string, unknown>
  ctxAvailable: boolean
}

describe('inspector getConn (slice 4)', () => {
  it('snapshots ctx + conn.data for a local conn, redacting and safely serializing', async () => {
    const circular: Record<string, unknown> = { name: 'node' }
    circular.self = circular
    const { srv, url } = await h.server(ctxContract, {
      authenticate: () => ({
        role: 'user' as const,
        ctx: { userId: 'u1', token: 'secret', big: 10n, fn: () => 1, circular },
      }),
      onConnection: (conn) => {
        ;(conn.data as { count?: number }).count = 5
      },
      inspector: { redact: ['token'] },
    })
    srv.implement({ user: { ping: async () => 1 } })

    const u = h.client(ctxContract, { url, role: 'user' })
    await u.ping()
    await waitFor(() => srv.local.connections.length === 1)
    const id = srv.local.connections[0]!.id

    const insp = await connectInspector(url)
    const view = (await insp.request('getConn', { id })) as ConnViewResult
    expect(view.ctxAvailable).toBe(true)
    expect(view.descriptor.id).toBe(id)
    expect(view.descriptor.role).toBe('user')
    expect(view.ctx?.userId).toBe('u1')
    expect(view.ctx?.token).toBe('[Redacted]') // redacted by field name
    expect(view.ctx?.big).toBe('10n') // BigInt -> string
    expect(view.ctx?.fn).toBe('[Function]')
    const circ = view.ctx?.circular as { self?: unknown } | undefined
    expect(circ?.self).toBe('[Circular]')
    expect(view.data?.count).toBe(5)
    insp.close()
  })

  it('returns NOT_FOUND for an unknown connection id', async () => {
    const { url } = await h.server(ctxContract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      inspector: true,
    })
    const insp = await connectInspector(url)
    await expect(insp.request('getConn', { id: 'nope' })).rejects.toThrow('NOT_FOUND')
    insp.close()
  })

  it('reports ctxAvailable:false for a conn owned by another node', async () => {
    const bus = new MemoryBus()
    const mk = () =>
      h.server(ctxContract, {
        authenticate: () => ({ role: 'user' as const, ctx: { secret: 1 } }),
        adapter: createInMemoryAdapter(bus),
        inspector: true,
      })
    const nodeA = await mk()
    const nodeB = await mk()
    nodeA.srv.implement({ user: { ping: async () => 1 } })
    nodeB.srv.implement({ user: { ping: async () => 1 } })

    const u = h.client(ctxContract, { url: nodeB.url, role: 'user' })
    await u.ping()
    await waitFor(() => nodeB.srv.local.connections.length === 1)
    const id = nodeB.srv.local.connections[0]!.id

    const insp = await connectInspector(nodeA.url) // inspector on A, conn on B
    const view = (await insp.request('getConn', { id })) as ConnViewResult
    expect(view.ctxAvailable).toBe(false)
    expect(view.ctx).toBeUndefined()
    expect(view.descriptor.id).toBe(id)
    insp.close()
  })
})

const eventsContract = defineContract({
  roles: {
    user: {
      clientToServer: { join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) } },
      serverToClient: { feed: { payload: z.object({ n: z.number() }), subscribe: true } },
    },
  },
})
const eventsAuth = () => ({ role: 'user' as const, ctx: {} })

describe('inspector events topic (slice 5)', () => {
  it('pushes live connect / room / topic / disconnect events to subscribed inspectors', async () => {
    const { srv, url } = await h.server(eventsContract, { authenticate: eventsAuth, inspector: true })
    srv.implement({
      user: { join: async ({ room }, _ctx, conn) => (srv.room(room).add(conn), { ok: true }) },
    })

    const insp = await connectInspector(url)
    await insp.subscribeEvents()

    const u = h.client(eventsContract, { url, role: 'user' })
    await u.join({ room: 'lobby' })
    const sub = u.subscribe('feed', () => {})
    await sub.ready

    await waitFor(() => insp.events.some((e) => e.type === 'connect'))
    await waitFor(() => insp.events.some((e) => e.type === 'room.add'))
    await waitFor(() => insp.events.some((e) => e.type === 'topic.sub'))

    const connectEv = insp.events.find((e) => e.type === 'connect')
    expect(connectEv?.descriptor?.role).toBe('user')
    expect(insp.events.find((e) => e.type === 'room.add')?.room).toBe('lobby')
    expect(insp.events.find((e) => e.type === 'topic.sub')?.topic).toBe('feed')

    u.close()
    await waitFor(() => insp.events.some((e) => e.type === 'disconnect'))
    // disconnect also tears down the conn's room/topic memberships -> remove/unsub events
    await waitFor(() => insp.events.some((e) => e.type === 'room.remove'))
    await waitFor(() => insp.events.some((e) => e.type === 'topic.unsub'))
    insp.close()
  })

  it('fans out events across nodes (conn on B reaches an inspector on A)', async () => {
    const bus = new MemoryBus()
    const mk = () =>
      h.server(eventsContract, {
        authenticate: eventsAuth,
        adapter: createInMemoryAdapter(bus),
        inspector: true,
      })
    const nodeA = await mk()
    const nodeB = await mk()
    nodeA.srv.implement({ user: { join: async () => ({ ok: true }) } })
    nodeB.srv.implement({ user: { join: async () => ({ ok: true }) } })

    const insp = await connectInspector(nodeA.url) // inspector on A
    await insp.subscribeEvents()

    const u = h.client(eventsContract, { url: nodeB.url, role: 'user' }) // conn on B
    await u.join({ room: 'x' })

    await waitFor(() => insp.events.some((e) => e.type === 'connect'))
    const connectEv = insp.events.find((e) => e.type === 'connect')
    expect(connectEv?.descriptor?.nodeId).toBe(nodeB.srv.nodeId) // event originated on B
    insp.close()
  })
})
