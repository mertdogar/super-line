import { execSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { defineContract } from '@super-line/core'
import { createRedisAdapter } from '@super-line/adapter-redis'
import { createHarness, tick, waitFor } from './harness.js'

// Requires Docker (testcontainers spins up redis:7); skipped cleanly when Docker is absent.
let dockerAvailable = true
try {
  execSync('docker info', { stdio: 'ignore' })
} catch {
  dockerAvailable = false
}
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

let container: StartedTestContainer
let redisUrl: string

beforeAll(async () => {
  container = await new GenericContainer('redis:7').withExposedPorts(6379).start()
  redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`
}, 120_000)

afterAll(async () => {
  await container?.stop()
})

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
        n.srv.room(room).add(conn)
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
    await waitFor(() => received.length === 1, 5000)
    expect(received[0]).toEqual({ symbol: 'NVDA', price: 9 })
  })

  it('delivers a room broadcast across nodes', async () => {
    const nodeA = await node()
    const nodeB = await node()

    const client = h.client(contract, { url: nodeA.url, role: 'user' })
    const got: Array<{ text: string }> = []
    client.on('message', (m) => got.push(m))

    await client.join({ room: 'lobby' })
    // room.add subscribes the redis channel fire-and-forget (no ack); retry the broadcast
    // until it lands, tolerating the SUBSCRIBE-propagation window (a non-issue in real apps,
    // where add and broadcast aren't in the same millisecond).
    for (let i = 0; i < 50 && got.length === 0; i++) {
      nodeB.srv.room('lobby').broadcast('message', { text: 'hi-redis' })
      await tick(100)
    }
    expect(got[0]).toEqual({ text: 'hi-redis' })
  })
})
