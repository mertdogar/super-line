import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createHarness, waitFor } from './harness.js'
import { adapterOn, makeNodes, type Nodes, type PubSubLibp2p } from './libp2p-cluster.js'

// Every adapter channel type, end-to-end through the full server stack, over the
// libp2p adapter (fast in-memory transport). Mirrors the redis cross-node suites.
// Nodes are built once per file; each test gets fresh, cheap adapters on them.
const contract = defineContract({
  shared: {
    clientToServer: {
      hello: { input: z.object({}), output: z.object({ ok: z.boolean() }) },
      join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
    },
    serverToClient: {
      message: { payload: z.object({ text: z.string() }) }, // room broadcast (r:)
      notice: { payload: z.object({ text: z.string() }) }, // toUser emit (u:)
      confirm: { input: z.object({ q: z.string() }), output: z.object({ ok: z.boolean() }) }, // server→client request (c: + reply:)
      announce: { payload: z.object({ msg: z.string() }), subscribe: true }, // cluster bus (s2s)
    },
  },
  roles: {
    user: {
      serverToClient: {
        prices: { payload: z.object({ symbol: z.string(), price: z.number() }), subscribe: true }, // topic (t:)
      },
    },
  },
})

function auth(req: { url?: string }) {
  const u = new URL(req.url ?? '', 'http://localhost')
  return { role: 'user' as const, ctx: { userId: u.searchParams.get('uid') ?? 'anon' } }
}
const identify = (conn: { ctx: unknown }) => (conn.ctx as { userId: string }).userId

const h = createHarness()
let cluster: Nodes
beforeAll(async () => {
  cluster = await makeNodes(2)
}, 30_000)
afterAll(() => cluster.dispose())
afterEach(() => h.dispose())

async function serverOn(node: PubSubLibp2p) {
  const n = await h.server(contract, { authenticate: auth, identify, adapter: await adapterOn(node) })
  n.srv.implement({
    shared: {
      hello: async () => ({ ok: true }),
      join: async ({ room }, _ctx, conn) => {
        n.srv.room(room).add(conn)
        return { ok: true }
      },
    },
    user: {},
  })
  return n
}

describe('libp2p adapter — channel types cross-node (memory transport)', () => {
  it('t: delivers a topic publish from node B to a subscriber on node A', async () => {
    const a = await serverOn(cluster.nodes[0]!)
    const b = await serverOn(cluster.nodes[1]!)
    const client = h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    const got: Array<{ symbol: string; price: number }> = []
    await client.subscribe('prices', (p) => got.push(p)).ready

    await waitFor(async () => {
      if (got.length === 0) b.srv.forRole('user').publish('prices', { symbol: 'NVDA', price: 9 })
      return got.length > 0
    }, 8000)
    expect(got[0]).toEqual({ symbol: 'NVDA', price: 9 })
  })

  it('r: delivers a room broadcast from node B to a member on node A', async () => {
    const a = await serverOn(cluster.nodes[0]!)
    const b = await serverOn(cluster.nodes[1]!)
    const client = h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    const got: Array<{ text: string }> = []
    client.on('message', (m) => got.push(m))
    await client.join({ room: 'lobby' })

    await waitFor(async () => {
      if (got.length === 0) b.srv.room('lobby').broadcast('message', { text: 'hi' })
      return got.length > 0
    }, 8000)
    expect(got[0]).toEqual({ text: 'hi' })
  })

  it('u: toUser(uid).emit reaches a client held by another node', async () => {
    const a = await serverOn(cluster.nodes[0]!)
    const b = await serverOn(cluster.nodes[1]!)
    const client = h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    const got: Array<{ text: string }> = []
    client.on('notice', (m) => got.push(m))
    await client.hello({})
    await waitFor(() => a.srv.local.connections.length === 1)

    await waitFor(async () => {
      if (got.length === 0) b.srv.toUser('u1').emit('notice', { text: 'cross' })
      return got.length > 0
    }, 8000)
    expect(got[0]).toEqual({ text: 'cross' })
  })

  it('c:/reply: toConn(id).request round-trips across nodes', async () => {
    const a = await serverOn(cluster.nodes[0]!)
    const b = await serverOn(cluster.nodes[1]!)
    const client = h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    client.implement({ confirm: async ({ q }) => ({ ok: q === 'go' }) })
    await client.hello({})
    await waitFor(() => a.srv.local.connections.length === 1)

    const id = a.srv.local.connections[0]!.id
    const answer = await b.srv.toConn(id).request('confirm', { q: 'go' }, { timeout: 8000 })
    expect(answer).toEqual({ ok: true })
  })

  it('s2s: server.publish from node B reaches a server.subscribe on node A, tagged from B', async () => {
    const a = await serverOn(cluster.nodes[0]!)
    const b = await serverOn(cluster.nodes[1]!)
    const got: Array<{ msg: string; from: string }> = []
    a.srv.subscribe('announce', (d, m) => got.push({ msg: d.msg, from: m.from }))

    await waitFor(async () => {
      if (got.length === 0) b.srv.publish('announce', { msg: 'from-b' })
      return got.length > 0
    }, 8000)
    expect(got[0]).toEqual({ msg: 'from-b', from: b.srv.nodeId })
  })
})
