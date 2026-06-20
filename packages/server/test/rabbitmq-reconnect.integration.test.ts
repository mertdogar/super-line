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
    },
  },
})

let container: StartedTestContainer
let amqpUrl: string

// A FIXED host port is required for this test: testcontainers reassigns an ephemeral host port on
// container.restart(), which would strand the adapters dialing the old port. A fixed binding is
// preserved across restart so the adapters reconnect to the same endpoint.
const HOST_PORT = 35672

beforeAll(async () => {
  container = await new GenericContainer('rabbitmq:4')
    .withExposedPorts({ container: 5672, host: HOST_PORT })
    .withEnvironment({ RABBITMQ_DEFAULT_USER: 'superline', RABBITMQ_DEFAULT_PASS: 'superline' })
    .withWaitStrategy(Wait.forLogMessage('Server startup complete'))
    .withStartupTimeout(180_000)
    .start()
  amqpUrl = `amqp://superline:superline@${container.getHost()}:${HOST_PORT}`
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

describe.skipIf(!dockerAvailable)('rabbitmq adapter reconnect resilience', () => {
  it('replays the dynamic room binding and resumes fan-out after a broker restart', async () => {
    const nodeA = await node()
    const nodeB = await node()

    const client = h.client(contract, { url: nodeA.url, role: 'user' })
    const got: Array<{ text: string }> = []
    client.on('message', (m) => got.push(m))

    // baseline: the `r:lobby` binding fans out before the restart
    await client.join({ room: 'lobby' })
    for (let i = 0; i < 50 && !got.some((m) => m.text === 'before'); i++) {
      nodeB.srv.room('lobby').broadcast('message', { text: 'before' })
      await tick(100)
    }
    expect(got.some((m) => m.text === 'before')).toBe(true)

    // Restart the broker: drops all AMQP connections, the exclusive queues, and the dynamic
    // bindings. The durable exchange survives (and both adapters re-declare it on reconnect).
    // The client↔nodeA WebSocket and the server-side room membership are unaffected.
    await container.restart()

    // After auto-reconnect, the Consumer re-declares the queue + emits `ready`, and the reconcile
    // replays the `r:lobby` binding — so a fresh broadcast reaches the client again. Retry through
    // the reconnect window (broker boot + backoff + rebind).
    await waitFor(async () => {
      nodeB.srv.room('lobby').broadcast('message', { text: 'after' })
      await tick(250)
      return got.some((m) => m.text === 'after')
    }, 60_000)
    expect(got.some((m) => m.text === 'after')).toBe(true)
  }, 90_000)
})
