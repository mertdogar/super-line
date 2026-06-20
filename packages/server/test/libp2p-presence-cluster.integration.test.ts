import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import type { Adapter } from '@super-line/core'
import { createHarness, waitFor } from './harness.js'
import { adapterOn, makeNodes, type Nodes } from './libp2p-cluster.js'

// Cluster presence through the full server (srv.cluster.* / isOnline), over libp2p adapters.
// Mirrors the redis-presence suite. Fresh nodes per test for clean replicas.
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
  return {
    role: (u.searchParams.get('role') as 'user' | 'agent') ?? 'user',
    ctx: { userId: u.searchParams.get('uid') ?? 'anon' },
  }
}
const identify = (conn: { ctx: unknown }) => (conn.ctx as { userId: string }).userId

const h = createHarness()
let cluster: Nodes | undefined
afterEach(async () => {
  await h.dispose()
  await cluster?.dispose()
  cluster = undefined
})

async function serverOn(adapter: Adapter) {
  const n = await h.server(contract, { authenticate: auth, identify, adapter })
  n.srv.implement({
    shared: { joinRoom: async ({ room }, _c, conn) => (n.srv.room(room).add(conn), { ok: true }) },
    user: {},
    agent: {},
  })
  return n
}

describe('libp2p adapter — cluster presence through the server (memory transport)', () => {
  it('aggregates connections, users, rooms and topology across nodes', async () => {
    cluster = await makeNodes(2)
    const a = await serverOn(await adapterOn(cluster.nodes[0]!))
    const b = await serverOn(await adapterOn(cluster.nodes[1]!))
    const ca = h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    h.client(contract, { url: b.url, role: 'agent', params: { uid: 'u2' } })
    await ca.joinRoom({ room: 'lobby' })

    await waitFor(async () => (await a.srv.cluster.count()) === 2, 8000)
    expect(await b.srv.cluster.count()).toBe(2)
    expect(await a.srv.cluster.byUser('u1')).toHaveLength(1)
    expect(await a.srv.isOnline('u1')).toBe(true)
    expect(await a.srv.isOnline('ghost')).toBe(false)

    const lobby = await b.srv.cluster.room('lobby')
    expect(lobby.map((d) => d.userId)).toEqual(['u1'])
    const topo = await a.srv.cluster.topology()
    expect(new Set(topo.map((n) => n.nodeId))).toEqual(new Set([a.srv.nodeId, b.srv.nodeId]))
  })

  it('drops a crashed node’s connections after the liveness TTL', async () => {
    cluster = await makeNodes(2)
    const aAdapter = await adapterOn(cluster.nodes[0]!, { snapshotIntervalMs: 200, livenessTtlMs: 1000 })
    const bAdapter = await adapterOn(cluster.nodes[1]!, { snapshotIntervalMs: 200, livenessTtlMs: 1000 })
    const a = await serverOn(aAdapter)
    const b = await serverOn(bAdapter)
    h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    h.client(contract, { url: b.url, role: 'user', params: { uid: 'u2' } })
    await waitFor(async () => (await a.srv.cluster.count()) === 2, 8000)

    await bAdapter.close?.() // simulate crash: B stops gossiping snapshots

    await waitFor(async () => (await a.srv.cluster.count()) === 1, 8000)
    expect((await a.srv.cluster.connections()).map((d) => d.userId)).toEqual(['u1'])
    expect((await a.srv.cluster.topology()).map((n) => n.nodeId)).toEqual([a.srv.nodeId])
  })

  it('removes a node’s entries immediately on graceful close', async () => {
    cluster = await makeNodes(2)
    const a = await serverOn(await adapterOn(cluster.nodes[0]!))
    const b = await serverOn(await adapterOn(cluster.nodes[1]!))
    h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    h.client(contract, { url: b.url, role: 'user', params: { uid: 'u2' } })
    await waitFor(async () => (await a.srv.cluster.count()) === 2, 8000)

    await b.srv.close() // clearNode broadcasts a 'leave' — immediate, no TTL wait

    await waitFor(async () => (await a.srv.cluster.count()) === 1, 8000)
  })

  it('presence:false makes cluster queries throw', async () => {
    cluster = await makeNodes(1)
    const a = await serverOn(await adapterOn(cluster.nodes[0]!, false))
    await expect(a.srv.cluster.connections()).rejects.toThrow(/presence/i)
  })
})
