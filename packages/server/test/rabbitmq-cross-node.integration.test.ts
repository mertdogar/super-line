import { execSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { defineContract } from '@super-line/core'
import { createRabbitmqAdapter } from '@super-line/adapter-rabbitmq'
import { createHarness, tick, waitFor } from './harness.js'

// Requires Docker (testcontainers spins up rabbitmq:4); skipped cleanly when Docker is absent.
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
let amqpUrl: string

beforeAll(async () => {
  // RabbitMQ boots slower than Redis — wait for the log line, generous startup timeout.
  // A custom default user is needed: the built-in `guest` is refused over the mapped port
  // (RabbitMQ restricts `guest` to loopback connections).
  container = await new GenericContainer('rabbitmq:4')
    .withExposedPorts(5672)
    .withEnvironment({ RABBITMQ_DEFAULT_USER: 'superline', RABBITMQ_DEFAULT_PASS: 'superline' })
    .withWaitStrategy(Wait.forLogMessage('Server startup complete'))
    .withStartupTimeout(180_000)
    .start()
  amqpUrl = `amqp://superline:superline@${container.getHost()}:${container.getMappedPort(5672)}`
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

const h = createHarness()
afterEach(() => h.dispose())

async function node() {
  const n = await h.server(contract, {
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    adapter: await createRabbitmqAdapter(amqpUrl),
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

describe.skipIf(!dockerAvailable)('rabbitmq adapter cross-process fan-out', () => {
  it('delivers a topic publish from node B to a subscriber on node A', async () => {
    const nodeA = await node()
    const nodeB = await node()

    const client = h.client(contract, { url: nodeA.url, role: 'user' })
    const received: Array<{ symbol: string; price: number }> = []
    // ready awaits the queueBind (subscribe awaits adapter.subscribe), so no race
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
    // room.add binds the channel fire-and-forget (no ack); retry the broadcast until it lands,
    // tolerating the bind-propagation window (a non-issue in real apps).
    for (let i = 0; i < 50 && got.length === 0; i++) {
      nodeB.srv.room('lobby').broadcast('message', { text: 'hi-rabbitmq' })
      await tick(100)
    }
    expect(got[0]).toEqual({ text: 'hi-rabbitmq' })
  })

  it('rejects a channel name exceeding the 255-byte routing-key limit', async () => {
    const adapter = await createRabbitmqAdapter(amqpUrl)
    const long = 'r:' + 'x'.repeat(300)
    await expect(adapter.subscribe(long)).rejects.toThrow(/255-byte/)
    expect(() => adapter.publish(long, 'x')).toThrow(/255-byte/)
    await adapter.close?.()
  })
})
