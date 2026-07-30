import { afterEach, describe, expect, inject, it } from 'vitest'
import * as z from 'zod'
import { defineContract } from '@super-line/core'
import { createRedisAdapter } from '@super-line/adapter-redis'
import { createHarness, waitFor } from './harness.js'

// Docker is probed once for the whole lane in global-docker.ts.
const dockerAvailable = inject('dockerAvailable')
const contract = defineContract({
  shared: {
    serverToClient: { message: { payload: z.object({ text: z.string() }) } },
  },
  roles: {
    user: {
      clientToServer: {
        join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
      },
      serverToClient: {
        prices: { payload: z.object({ symbol: z.string(), price: z.number() }), subscribe: true },
      },
    },
  },
})

const redisUrl = inject('redisUrl')

const h = createHarness()
afterEach(() => h.dispose())

async function node() {
  const n = await h.server(contract, {
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    adapter: createRedisAdapter(redisUrl),
  })
  n.srv.implement({
    user: {
      join: async ({ room }, _ctx, conn) => {
        await n.srv.room(room).add(conn)
        return { ok: true }
      },
    },
  })
  return n
}

describe.skipIf(!dockerAvailable)('redis adapter cross-process fan-out', () => {
  it('delivers a topic publish from node B to a subscriber on node A', async () => {
    const nodeA = await node()
    const nodeB = await node()

    const client = h.client(contract, { url: nodeA.url, role: 'user' })
    const received: Array<{ symbol: string; price: number }> = []
    // ready awaits the redis SUBSCRIBE (handleSub awaits adapter.subscribe), so no race
    await client.subscribe('prices', (p) => received.push(p)).ready

    nodeB.srv.forRole('user').publish('prices', { symbol: 'NVDA', price: 9 })
    await waitFor(() => received.length === 1, 10000)
    expect(received[0]).toEqual({ symbol: 'NVDA', price: 9 })
  })

  it('delivers a room broadcast across nodes', async () => {
    const nodeA = await node()
    const nodeB = await node()

    const client = h.client(contract, { url: nodeA.url, role: 'user' })
    const got: Array<{ text: string }> = []
    client.on('message', (m) => got.push(m))

    // The `join` handler awaits room.add, so the response carries readiness: by the time this
    // resolves the redis SUBSCRIBE has landed and ONE broadcast is enough.
    await client.join({ room: 'lobby' })
    nodeB.srv.room('lobby').broadcast('message', { text: 'hi-redis' })

    await waitFor(() => got.length === 1, { timeout: 10_000, label: 'a room broadcast on B reaches a member on A' })
    expect(got[0]).toEqual({ text: 'hi-redis' })
  })
})
