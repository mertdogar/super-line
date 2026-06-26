import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, INSPECTOR_SUBPROTOCOL } from '@super-line/core'
import type { InspectedContract, Schema } from '@super-line/core'
import { MemoryBus, createInMemoryAdapter } from '@super-line/server'
import { connectInspector, createHarness, tick, waitFor } from './harness.js'

const contract = defineContract({
  roles: {
    user: { clientToServer: { ping: { input: z.void(), output: z.number() } } },
    agent: {},
  },
})

function authenticate(h: { query: Record<string, string> }) {
  const role = h.query.role as 'user' | 'agent'
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

    const node = (await insp.request('getNode')) as {
      nodeId: string
      nodeName: string
      rooms: string[]
      topics: string[]
    }
    expect(node.nodeId).toBe(srv.nodeId)
    expect(node.nodeName).toBe(srv.nodeName)
    expect(node.nodeName).toBe(srv.nodeId.slice(0, 8)) // default: short slice of nodeId
    expect(node.rooms).toEqual([])
    expect(node.topics).toEqual([])

    const conns = (await insp.request('listConnections')) as Array<{ role: string }>
    expect(conns).toHaveLength(2) // the inspector itself is excluded from presence
    expect(conns.every((cn) => cn.role === 'user')).toBe(true)

    const topo = (await insp.request('getTopology')) as Array<{ nodeId: string; nodeName: string; connections: number }>
    expect(topo).toHaveLength(1)
    expect(topo[0]?.nodeId).toBe(srv.nodeId)
    expect(topo[0]?.connections).toBe(2) // inspector not counted

    // observer-invisible in the server's own local view too
    expect(srv.local.connections).toHaveLength(2)

    insp.close()
  })

  it('surfaces a friendly nodeName through getNode / getTopology / listConnections', async () => {
    const { srv, url } = await h.server(contract, { authenticate, inspector: true, nodeName: 'node-A' })
    srv.implement({ user: { ping: async () => 1 }, agent: {} })
    expect(srv.nodeName).toBe('node-A')

    const u = h.client(contract, { url, role: 'user' })
    await u.ping()
    await waitFor(() => srv.local.connections.length === 1)

    const insp = await connectInspector(url)
    const node = (await insp.request('getNode')) as { nodeName: string }
    expect(node.nodeName).toBe('node-A')
    const topo = (await insp.request('getTopology')) as Array<{ nodeName: string }>
    expect(topo[0]?.nodeName).toBe('node-A')
    const conns = (await insp.request('listConnections')) as Array<{ nodeName: string }>
    expect(conns[0]?.nodeName).toBe('node-A')
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
    // the envelope's originNodeId is the emitting (origin) node, not the receiving inspector's node
    expect(insp.envelopes.find((en) => en.event.type === 'connect')?.originNodeId).toBe(nodeB.srv.nodeId)
    insp.close()
  })
})

const msgContract = defineContract({
  shared: { serverToClient: { ping: { payload: z.object({ n: z.number() }) } } },
  roles: {
    user: {
      clientToServer: {
        echo: {
          input: z.object({ text: z.string(), secret: z.string() }),
          output: z.object({ ok: z.boolean() }),
        },
        boom: { input: z.void(), output: z.void() },
      },
      serverToClient: { feed: { payload: z.object({ n: z.number() }), subscribe: true } },
    },
  },
})

describe('inspector message events (T3.2)', () => {
  it('mirrors request/response/event/broadcast/publish, redacting payload fields', async () => {
    const { srv, url } = await h.server(msgContract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      inspector: { redact: ['secret'] },
    })
    srv.implement({
      user: {
        echo: async (_in, _ctx, conn) => {
          conn.emit('ping', { n: 3 })
          srv.room('r').add(conn)
          srv.room('r').broadcast('ping', { n: 1 })
          srv.forRole('user').publish('feed', { n: 2 })
          return { ok: true }
        },
        boom: async () => {
          throw new Error('nope')
        },
      },
    })

    const insp = await connectInspector(url)
    await insp.subscribeEvents()
    const u = h.client(msgContract, { url, role: 'user' })
    await u.echo({ text: 'hi', secret: 's3cr3t' })

    await waitFor(() => insp.events.some((e) => e.type === 'msg.request'))
    const req = insp.events.find((e) => e.type === 'msg.request')
    expect(req?.name).toBe('echo')
    const input = req?.input as { text: string; secret: string }
    expect(input.text).toBe('hi')
    expect(input.secret).toBe('[Redacted]') // redacted by field name before crossing the bus

    const res = insp.events.find((e) => e.type === 'msg.response')
    expect(res?.ok).toBe(true)
    expect(insp.events.find((e) => e.type === 'msg.event')?.name).toBe('ping') // conn.emit
    expect(insp.events.find((e) => e.type === 'msg.broadcast')?.room).toBe('r')
    expect(insp.events.find((e) => e.type === 'msg.publish')?.topic).toBe('feed')

    // a thrown handler still emits a failed response
    await u.boom().catch(() => {})
    await waitFor(() => insp.events.some((e) => e.type === 'msg.response' && e.ok === false))
    const errRes = insp.events.find((e) => e.type === 'msg.response' && e.ok === false)
    expect(errRes?.name).toBe('boom')
    insp.close()
  })

  it('wraps every event in an envelope with ts, originNodeId, and payload-only byteSize', async () => {
    const { srv, url } = await h.server(msgContract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      inspector: true,
    })
    srv.implement({
      user: { echo: async () => ({ ok: true }), boom: async () => {} },
    })

    const insp = await connectInspector(url)
    await insp.subscribeEvents()
    const u = h.client(msgContract, { url, role: 'user' })
    await u.echo({ text: 'hi', secret: 's3cr3t' })

    await waitFor(() => insp.envelopes.some((en) => en.event.type === 'connect'))
    await waitFor(() => insp.envelopes.some((en) => en.event.type === 'msg.request'))

    const connect = insp.envelopes.find((en) => en.event.type === 'connect')!
    expect(typeof connect.ts).toBe('number')
    expect(connect.originNodeId).toBe(srv.nodeId)
    expect(connect.byteSize).toBeUndefined() // lifecycle event carries no payload

    const req = insp.envelopes.find((en) => en.event.type === 'msg.request')!
    expect(req.byteSize).toBeGreaterThan(0) // request input has a payload, so it's sized
    u.close()
    insp.close()
  })

  it('tags request/response with a reqId so concurrent same-name calls pair unambiguously', async () => {
    const { srv, url } = await h.server(msgContract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      inspector: true,
    })
    // a tiny delay keeps both echoes in flight at once, exercising the concurrency case
    srv.implement({
      user: { echo: async () => (await tick(20), { ok: true }), boom: async () => {} },
    })

    const insp = await connectInspector(url)
    await insp.subscribeEvents()
    const u = h.client(msgContract, { url, role: 'user' })
    await Promise.all([u.echo({ text: 'a', secret: 'x' }), u.echo({ text: 'b', secret: 'y' })])

    await waitFor(() => insp.events.filter((e) => e.type === 'msg.response').length === 2)
    const reqIds = insp.events.filter((e) => e.type === 'msg.request').map((e) => e.reqId)
    expect(new Set(reqIds).size).toBe(2) // two in-flight same-name requests got distinct ids

    // every response pairs back to a request by reqId
    for (const res of insp.events.filter((e) => e.type === 'msg.response')) {
      expect(reqIds).toContain(res.reqId)
    }
    u.close()
    insp.close()
  })

  it('byteSize measures the redacted snapshot, not the raw payload', async () => {
    const big = 'x'.repeat(5000)
    const { srv, url } = await h.server(msgContract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      inspector: { redact: ['secret'] },
    })
    srv.implement({ user: { echo: async () => ({ ok: true }), boom: async () => {} } })
    const insp = await connectInspector(url)
    await insp.subscribeEvents()
    const u = h.client(msgContract, { url, role: 'user' })
    await u.echo({ text: 'hi', secret: big })

    await waitFor(() => insp.envelopes.some((en) => en.event.type === 'msg.request'))
    const req = insp.envelopes.find((en) => en.event.type === 'msg.request')!
    // the 5000-char secret is redacted to '[Redacted]', so the sized snapshot is tiny, not ~5KB
    expect(req.byteSize).toBeGreaterThan(0)
    expect(req.byteSize).toBeLessThan(big.length)
    u.close()
    insp.close()
  })
})

const srvReqContract = defineContract({
  shared: {
    clientToServer: { hello: { input: z.object({}), output: z.object({ ok: z.boolean() }) } },
    serverToClient: { confirm: { input: z.object({ q: z.string() }), output: z.object({ ok: z.boolean() }) } },
  },
  roles: { user: {} },
})

describe('inspector server→client request pairing', () => {
  it('tags serverRequest and serverReply with a shared reqId', async () => {
    const { srv, url } = await h.server(srvReqContract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      inspector: true,
    })
    srv.implement({ shared: { hello: async () => ({ ok: true }) }, user: {} })

    const insp = await connectInspector(url)
    await insp.subscribeEvents()
    const u = h.client(srvReqContract, { url, role: 'user' })
    u.implement({ confirm: async ({ q }) => ({ ok: q === 'go' }) })
    await u.hello({})
    await waitFor(() => srv.local.connections.length === 1)
    const id = srv.local.connections[0]!.id
    await srv.toConn(id).request('confirm', { q: 'go' })

    await waitFor(() => insp.events.some((e) => e.type === 'msg.serverReply'))
    const sreq = insp.events.find((e) => e.type === 'msg.serverRequest')!
    const srep = insp.events.find((e) => e.type === 'msg.serverReply')!
    expect(typeof sreq.reqId).toBe('number')
    expect(srep.reqId).toBe(sreq.reqId) // shared id → the CC can pair reply to request for latency
    u.close()
    insp.close()
  })
})
