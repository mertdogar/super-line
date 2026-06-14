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
  messages: {
    join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
  },
  events: {
    message: z.object({ text: z.string() }),
  },
  topics: {
    prices: z.object({ symbol: z.string(), price: z.number() }),
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
    authenticate: () => ({}),
    adapter: createRedisAdapter(redisUrl),
  })
  n.srv.implement({
    join: async ({ room }, _ctx, conn) => {
      n.srv.room(room).add(conn)
      return { ok: true }
    },
  })
  return n
}

describe.skipIf(!dockerAvailable)('redis adapter cross-process fan-out', () => {
  it('delivers a topic publish from node B to a subscriber on node A', async () => {
    const nodeA = await node()
    const nodeB = await node()

    const client = h.client(contract, { url: nodeA.url })
    const received: Array<{ symbol: string; price: number }> = []
    // ready awaits the redis SUBSCRIBE (handleSub awaits adapter.subscribe), so no race
    await client.subscribe('prices', (p) => received.push(p)).ready

    nodeB.srv.publish('prices', { symbol: 'NVDA', price: 9 })
    await waitFor(() => received.length === 1, 5000)
    expect(received[0]).toEqual({ symbol: 'NVDA', price: 9 })
  })

  it('delivers a room broadcast across nodes', async () => {
    const nodeA = await node()
    const nodeB = await node()

    const client = h.client(contract, { url: nodeA.url })
    const got: Array<{ text: string }> = []
    client.on('message', (m) => got.push(m))

    await client.join({ room: 'lobby' })
    // room.add subscribes the channel fire-and-forget; let the redis SUBSCRIBE register
    await tick(150)

    nodeB.srv.room('lobby').broadcast('message', { text: 'hi-redis' })
    await waitFor(() => got.length === 1, 5000)
    expect(got[0]).toEqual({ text: 'hi-redis' })
  })
})
