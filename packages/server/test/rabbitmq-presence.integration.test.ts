import { execSync } from 'node:child_process'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { z } from 'zod'
import { defineContract, type Adapter } from '@super-line/core'
import { createRabbitmqAdapter } from '@super-line/adapter-rabbitmq'
import { createHarness, waitFor } from './harness.js'

// Requires Docker (the shared per-run rabbitmq:4 from global-docker.ts); skipped cleanly when Docker is absent.
// Cluster presence through the full server, over the duplicated gossip directory. Reconcile edge
// cases are unit-tested in adapter-rabbitmq/test/presence.reconcile.test.ts.
let dockerAvailable = true
try {
  execSync('docker info', { stdio: 'ignore' })
} catch {
  dockerAvailable = false
}

const contract = defineContract({
  shared: {
    clientToServer: {
      joinRoom: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
    },
  },
  roles: { user: {}, agent: {} },
})

function auth(h: { query: Record<string, string> }) {
  return {
    role: (h.query.role as 'user' | 'agent') ?? 'user',
    ctx: { userId: h.query.uid ?? 'anon' },
  }
}
const identify = (conn: { ctx: unknown }) => (conn.ctx as { userId: string }).userId

const amqpUrl = inject('amqpUrl')

const h = createHarness()
afterEach(() => h.dispose())

async function serverOn(adapter: Adapter) {
  const n = await h.server(contract, { authenticate: auth, identify, adapter })
  n.srv.implement({
    shared: { joinRoom: async ({ room }, _c, conn) => (n.srv.room(room).add(conn), { ok: true }) },
    user: {},
    agent: {},
  })
  return n
}

describe.skipIf(!dockerAvailable)('rabbitmq presence cross-process (slice 4)', () => {
  it('aggregates connections, users, rooms and topology across processes', async () => {
    const a = await serverOn(await createRabbitmqAdapter(amqpUrl))
    const b = await serverOn(await createRabbitmqAdapter(amqpUrl))

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
    expect(topo.every((n) => n.alive)).toBe(true)
  })

  it('drops a crashed node’s connections after the liveness TTL', async () => {
    const timings = { presence: { snapshotIntervalMs: 200, livenessTtlMs: 1000 } }
    const aAdapter = await createRabbitmqAdapter({ url: amqpUrl, ...timings })
    const bAdapter = await createRabbitmqAdapter({ url: amqpUrl, ...timings })
    const a = await serverOn(aAdapter)
    const b = await serverOn(bAdapter)
    h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    h.client(contract, { url: b.url, role: 'user', params: { uid: 'u2' } })
    await waitFor(async () => (await a.srv.cluster.count()) === 2, 8000)

    await bAdapter.close?.() // simulate crash: B stops gossiping snapshots (no graceful leave)

    await waitFor(async () => (await a.srv.cluster.count()) === 1, 8000)
    expect((await a.srv.cluster.topology()).map((n) => n.nodeId)).toEqual([a.srv.nodeId])
  })

  it('removes a node’s entries immediately on graceful close', async () => {
    const a = await serverOn(await createRabbitmqAdapter(amqpUrl))
    const b = await serverOn(await createRabbitmqAdapter(amqpUrl))
    h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    h.client(contract, { url: b.url, role: 'user', params: { uid: 'u2' } })
    await waitFor(async () => (await a.srv.cluster.count()) === 2, 8000)

    await b.srv.close() // clearNode broadcasts a 'leave' — immediate, no TTL wait

    await waitFor(async () => (await a.srv.cluster.count()) === 1, 8000)
  })

  it('presence:false makes cluster queries throw', async () => {
    const a = await serverOn(await createRabbitmqAdapter({ url: amqpUrl, presence: false }))
    await expect(a.srv.cluster.connections()).rejects.toThrow(/presence/i)
  })
})
