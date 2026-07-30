import { afterEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import { defineContract } from '@super-line/core'
import type { Adapter } from '@super-line/core'
import { createHarness, waitFor } from './harness.js'
import { makeCluster, makeProxyCluster, type Cluster } from './zeromq-cluster.js'

// Real sockets, and the lane's redis + rabbitmq containers are live alongside them. The lane runs
// serially (since 2026-07-16) but the machine is still shared, so give these generous headroom.
vi.setConfig({ testTimeout: 30_000 })

// Full-server parity suite for the ZeroMQ mesh adapter, over real loopback TCP (no Docker).
// Mirrors the redis-cross-node / redis-presence suites. Slow-joiner: SUB subscriptions
// propagate asynchronously, so one-shot fan-outs retry until the mesh settles (a non-issue
// in real apps where subscribe and publish aren't in the same millisecond).
const contract = defineContract({
  shared: {
    serverToClient: {
      message: { payload: z.object({ text: z.string() }) },
      announce: { payload: z.object({ n: z.number() }), subscribe: true },
    },
    clientToServer: {
      join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
    },
  },
  roles: {
    user: {
      serverToClient: {
        prices: { payload: z.object({ symbol: z.string(), price: z.number() }), subscribe: true },
      },
    },
    agent: {},
  },
})

function auth(h: { query: Record<string, string> }) {
  return {
    role: (h.query.role as 'user' | 'agent') ?? 'user',
    ctx: { userId: h.query.uid ?? 'anon' },
  }
}
const identify = (conn: { ctx: unknown }) => (conn.ctx as { userId: string }).userId

const h = createHarness()
let cluster: Cluster | undefined
afterEach(async () => {
  await h.dispose()
  await cluster?.dispose()
  cluster = undefined
})

async function serverOn(adapter: Adapter) {
  const n = await h.server(contract, { authenticate: auth, identify, adapter })
  n.srv.implement({
    shared: { join: async ({ room }, _c, conn) => (await n.srv.room(room).add(conn), { ok: true }) },
    user: {},
    agent: {},
  })
  return n
}

describe('zeromq adapter — cross-node fan-out through the server (mesh)', () => {
  it('delivers a topic publish from node B to a subscriber on node A', async () => {
    cluster = await makeCluster(2)
    const a = await serverOn(cluster.adapters[0]!)
    const b = await serverOn(cluster.adapters[1]!)
    const client = h.client(contract, { url: a.url, role: 'user' })
    const received: Array<{ symbol: string; price: number }> = []
    await client.subscribe('prices', (p) => received.push(p)).ready

    await waitFor(async () => {
      b.srv.forRole('user').publish('prices', { symbol: 'NVDA', price: 9 })
      return received.length > 0
    }, { timeout: 10_000, label: 'a topic publish on B reaches a subscriber on A' })
    expect(received[0]).toEqual({ symbol: 'NVDA', price: 9 })
  })

  it('delivers a room broadcast across nodes', async () => {
    cluster = await makeCluster(2)
    const a = await serverOn(cluster.adapters[0]!)
    const b = await serverOn(cluster.adapters[1]!)
    const client = h.client(contract, { url: a.url, role: 'user' })
    const got: Array<{ text: string }> = []
    client.on('message', (m) => got.push(m))
    await client.join({ room: 'lobby' })

    await waitFor(async () => {
      b.srv.room('lobby').broadcast('message', { text: 'hi-zmq' })
      return got.length > 0
    }, { timeout: 10_000, label: 'a room broadcast on B reaches a member on A' })
    expect(got[0]).toEqual({ text: 'hi-zmq' })
  })

  it('delivers a cluster-bus publish from node B to a server subscriber on node A', async () => {
    cluster = await makeCluster(2)
    const a = await serverOn(cluster.adapters[0]!)
    const b = await serverOn(cluster.adapters[1]!)
    const got: Array<{ d: unknown; from: string }> = []
    a.srv.subscribe('announce', (d, m) => got.push({ d, from: m.from }))

    await waitFor(async () => {
      b.srv.publish('announce', { n: 7 })
      return got.length > 0
    }, { timeout: 10_000, label: 'a cluster-bus publish on B reaches a subscriber on A' })
    expect(got[0]?.d).toEqual({ n: 7 })
    expect(got[0]?.from).toBe(b.srv.nodeId)
  })
})

describe('zeromq adapter — cluster presence through the server (mesh)', () => {
  it('aggregates connections, users, rooms and topology across nodes', async () => {
    cluster = await makeCluster(2)
    const a = await serverOn(cluster.adapters[0]!)
    const b = await serverOn(cluster.adapters[1]!)
    const ca = h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    h.client(contract, { url: b.url, role: 'agent', params: { uid: 'u2' } })
    await ca.join({ room: 'lobby' })

    // Gossip presence converges per NODE, so waiting on a's view says nothing about b's — assert only
    // once BOTH have caught up, or this races (and the old accept ordering merely happened to win it).
    await waitFor(async () => (await a.srv.cluster.count()) === 2 && (await b.srv.cluster.count()) === 2, {
      timeout: 25_000,
      label: 'both nodes see both connections',
    })
    expect(await b.srv.cluster.count()).toBe(2)
    expect(await a.srv.cluster.byUser('u1')).toHaveLength(1)
    expect(await a.srv.isOnline('u1')).toBe(true)
    expect(await a.srv.isOnline('ghost')).toBe(false)

    await waitFor(async () => (await b.srv.cluster.room('lobby')).length === 1, 25_000)
    expect((await b.srv.cluster.room('lobby')).map((d) => d.userId)).toEqual(['u1'])
    const topo = await a.srv.cluster.topology()
    expect(new Set(topo.map((n) => n.nodeId))).toEqual(new Set([a.srv.nodeId, b.srv.nodeId]))
  })

  it('drops a crashed node’s connections after the liveness TTL', async () => {
    cluster = await makeCluster(2, { snapshotIntervalMs: 200, livenessTtlMs: 1000 })
    const a = await serverOn(cluster.adapters[0]!)
    const b = await serverOn(cluster.adapters[1]!)
    h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    h.client(contract, { url: b.url, role: 'user', params: { uid: 'u2' } })
    await waitFor(async () => (await a.srv.cluster.count()) === 2, 25_000)

    await cluster.adapters[1]!.close?.() // simulate crash: B stops gossiping snapshots

    await waitFor(async () => (await a.srv.cluster.count()) === 1, 25_000)
    expect((await a.srv.cluster.connections()).map((d) => d.userId)).toEqual(['u1'])
    expect((await a.srv.cluster.topology()).map((n) => n.nodeId)).toEqual([a.srv.nodeId])
  })

  it('removes a node’s entries on graceful close', async () => {
    // The 'leave' broadcast is the fast path; on a lossy PUB/SUB transport the liveness TTL is
    // the guarantee, so a short TTL keeps this reliable even if the at-most-once leave drops.
    cluster = await makeCluster(2, { snapshotIntervalMs: 200, livenessTtlMs: 1500 })
    const a = await serverOn(cluster.adapters[0]!)
    const b = await serverOn(cluster.adapters[1]!)
    h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    h.client(contract, { url: b.url, role: 'user', params: { uid: 'u2' } })
    await waitFor(async () => (await a.srv.cluster.count()) === 2, 25_000)

    await b.srv.close() // clearNode broadcasts a 'leave' — immediate, no TTL wait

    await waitFor(async () => (await a.srv.cluster.count()) === 1, 25_000)
  })

  it('presence:false makes cluster queries throw', async () => {
    cluster = await makeCluster(1, false)
    const a = await serverOn(cluster.adapters[0]!)
    await expect(a.srv.cluster.connections()).rejects.toThrow(/presence/i)
  })
})

describe('zeromq adapter — through a central forwarder (mode: proxy)', () => {
  it('delivers a room broadcast and aggregates presence across nodes via the proxy', async () => {
    cluster = await makeProxyCluster(2)
    const a = await serverOn(cluster.adapters[0]!)
    const b = await serverOn(cluster.adapters[1]!)
    const client = h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    const got: Array<{ text: string }> = []
    client.on('message', (m) => got.push(m))
    await client.join({ room: 'lobby' })
    h.client(contract, { url: b.url, role: 'agent', params: { uid: 'u2' } })

    await waitFor(async () => {
      b.srv.room('lobby').broadcast('message', { text: 'via-proxy' })
      return got.length > 0
    }, { timeout: 10_000, label: 'a room broadcast crosses the XSUB/XPUB proxy' })
    expect(got[0]).toEqual({ text: 'via-proxy' })

    await waitFor(async () => (await b.srv.cluster.count()) === 2, 25_000)
    expect((await b.srv.cluster.byUser('u1')).map((d) => d.userId)).toEqual(['u1'])
  })
})
