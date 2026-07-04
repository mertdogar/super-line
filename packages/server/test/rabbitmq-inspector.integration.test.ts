import { execSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { defineContract } from '@super-line/core'
import { createRabbitmqAdapter } from '@super-line/adapter-rabbitmq'
import { inspector } from '@super-line/plugin-inspector'
import { connectInspector, createHarness, waitFor } from './harness.js'

// Requires Docker (testcontainers spins up rabbitmq:4); skipped cleanly when Docker is absent.
let dockerAvailable = true
try {
  execSync('docker info', { stdio: 'ignore' })
} catch {
  dockerAvailable = false
}

const contract = defineContract({
  roles: {
    user: {
      clientToServer: { join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) } },
    },
  },
})

let container: StartedTestContainer
let amqpUrl: string

beforeAll(async () => {
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
    plugins: [inspector()],
  })
  n.srv.implement({ user: { join: async () => ({ ok: true }) } })
  return n
}

describe.skipIf(!dockerAvailable)('rabbitmq inspector events cross-process', () => {
  it('delivers a connect event from node B to an inspector on node A', async () => {
    const nodeA = await node()
    const nodeB = await node()

    const insp = await connectInspector(nodeA.url) // inspector on A
    await insp.subscribeEvents() // awaits the queueBind to i:events, so no race

    const u = h.client(contract, { url: nodeB.url, role: 'user' }) // conn on B
    await u.join({ room: 'x' })

    await waitFor(() => insp.events.some((e) => e.type === 'connect'), 5000)
    const connectEv = insp.events.find((e) => e.type === 'connect')
    expect(connectEv?.descriptor?.nodeId).toBe(nodeB.srv.nodeId) // event originated on B
    insp.close()
  })

  it('delivers message events (request/response) from node B to an inspector on node A', async () => {
    const nodeA = await node()
    const nodeB = await node()

    const insp = await connectInspector(nodeA.url) // inspector on A
    await insp.subscribeEvents()

    const u = h.client(contract, { url: nodeB.url, role: 'user' }) // request handled on B
    await u.join({ room: 'x' }) // B emits msg.request/response; they must cross the bus to A

    await waitFor(() => insp.events.some((e) => e.type === 'msg.request'), 5000)
    const req = insp.events.find((e) => e.type === 'msg.request')
    expect(req?.name).toBe('join')
    const input = req?.input as { room: string } | undefined
    expect(input?.room).toBe('x')

    await waitFor(() => insp.events.some((e) => e.type === 'msg.response'), 5000)
    expect(insp.events.find((e) => e.type === 'msg.response')?.ok).toBe(true)
    insp.close()
  })
})
