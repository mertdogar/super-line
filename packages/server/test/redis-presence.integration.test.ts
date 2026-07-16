import { execSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { Redis } from 'ioredis'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createRedisAdapter } from '@super-line/adapter-redis'
import { createHarness, waitFor } from './harness.js'

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

const redisUrl = inject('redisUrl')
let raw: Redis

beforeAll(() => {
  raw = new Redis(redisUrl)
})

afterAll(async () => {
  await raw?.quit()
})

const h = createHarness()
afterEach(async () => {
  await h.dispose()
  await raw?.flushall()
})

async function node() {
  const n = await h.server(contract, {
    authenticate: auth,
    identify,
    adapter: createRedisAdapter(redisUrl),
  })
  n.srv.implement({
    shared: { joinRoom: async ({ room }, _c, conn) => (n.srv.room(room).add(conn), { ok: true }) },
    user: {},
    agent: {},
  })
  return n
}

describe.skipIf(!dockerAvailable)('redis presence cross-process (slice 4)', () => {
  it('aggregates connections, users, rooms and topology across processes', async () => {
    const a = await node()
    const b = await node()

    const ca = h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    h.client(contract, { url: b.url, role: 'agent', params: { uid: 'u2' } })
    await ca.joinRoom({ room: 'lobby' })

    await waitFor(async () => (await a.srv.cluster.count()) === 2, 5000)
    expect(await b.srv.cluster.count()).toBe(2)
    expect(await a.srv.cluster.byUser('u1')).toHaveLength(1)
    const lobby = await b.srv.cluster.room('lobby')
    expect(lobby.map((d) => d.userId)).toEqual(['u1'])

    const topo = await a.srv.cluster.topology()
    expect(new Set(topo.map((n) => n.nodeId))).toEqual(new Set([a.srv.nodeId, b.srv.nodeId]))
    expect(topo.every((n) => n.alive)).toBe(true)
  })

  it('drops a crashed node’s connections once its alive key expires', async () => {
    const a = await node()
    const b = await node()
    h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    h.client(contract, { url: b.url, role: 'user', params: { uid: 'u2' } })
    await waitFor(async () => (await a.srv.cluster.count()) === 2, 5000)

    // simulate node B crashing: its liveness key vanishes (TTL would have expired)
    await raw.del(`sl:alive:${b.srv.nodeId}`)

    await waitFor(async () => (await a.srv.cluster.count()) === 1, 5000)
    const all = await a.srv.cluster.connections()
    expect(all.map((d) => d.userId)).toEqual(['u1'])
    const topo = await a.srv.cluster.topology()
    expect(topo.map((n) => n.nodeId)).toEqual([a.srv.nodeId])
  })

  it('removes its entries immediately on graceful close', async () => {
    const a = await node()
    const b = await node()
    h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    h.client(contract, { url: b.url, role: 'user', params: { uid: 'u2' } })
    await waitFor(async () => (await a.srv.cluster.count()) === 2, 5000)

    await b.srv.close()

    await waitFor(async () => (await a.srv.cluster.count()) === 1, 5000)
    expect(await raw.exists(`sl:alive:${b.srv.nodeId}`)).toBe(0)
  })
})
