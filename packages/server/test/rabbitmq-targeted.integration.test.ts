import { execSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { defineContract, SocketError } from '@super-line/core'
import { createRabbitmqAdapter } from '@super-line/adapter-rabbitmq'
import { createHarness, waitFor } from './harness.js'

// Requires Docker (testcontainers spins up rabbitmq:4); skipped cleanly when Docker is absent.
// Targeted routing (c:/u:/reply:) does NOT depend on the presence directory — these tests use
// local connection ids + retry loops, so they stand on their own ahead of the presence slice.
let dockerAvailable = true
try {
  execSync('docker info', { stdio: 'ignore' })
} catch {
  dockerAvailable = false
}

const contract = defineContract({
  shared: {
    clientToServer: { hello: { input: z.object({}), output: z.object({ ok: z.boolean() }) } },
    serverToClient: {
      notice: { payload: z.object({ text: z.string() }) },
      confirm: { input: z.object({ q: z.string() }), output: z.object({ ok: z.boolean() }) },
    },
  },
  roles: { user: {} },
})

function auth(req: { url?: string }) {
  const u = new URL(req.url ?? '', 'http://localhost')
  return { role: 'user' as const, ctx: { userId: u.searchParams.get('uid') ?? 'anon' } }
}
const identify = (conn: { ctx: unknown }) => (conn.ctx as { userId: string }).userId

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
  const n = await h.server(contract, { authenticate: auth, identify, adapter: await createRabbitmqAdapter(amqpUrl) })
  n.srv.implement({ shared: { hello: async () => ({ ok: true }) }, user: {} })
  return n
}

describe.skipIf(!dockerAvailable)('rabbitmq targeted send + server→client request cross-process', () => {
  it('toUser(uid).emit reaches a client held by another process', async () => {
    const a = await node()
    const b = await node()
    const client = h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    const got: Array<{ text: string }> = []
    client.on('notice', (m) => got.push(m))
    await client.hello({})

    // tolerate the u:{uid} bind-propagation window (real apps don't send in the same ms as connect)
    await waitFor(async () => {
      if (got.length === 0) b.srv.toUser('u1').emit('notice', { text: 'cross' })
      return got.length > 0
    }, 10_000)
    expect(got[0]).toEqual({ text: 'cross' })
  })

  it('toConn(id).request round-trips across processes', async () => {
    const a = await node()
    const b = await node()
    const client = h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    client.implement({ confirm: async ({ q }) => ({ ok: q === 'go' }) })
    await client.hello({})
    await waitFor(() => a.srv.local.connections.length === 1, 5000)
    const id = a.srv.local.connections[0]!.id

    // retry until the c:{id} / reply:{node} binds have propagated, then the round-trip lands
    let answer: { ok: boolean } | undefined
    await waitFor(async () => {
      try {
        answer = await b.srv.toConn(id).request('confirm', { q: 'go' }, { timeout: 1500 })
        return true
      } catch {
        return false
      }
    }, 10_000)
    expect(answer).toEqual({ ok: true })
  })

  it('toConn(id).request rejects when no process owns the id', async () => {
    const b = await node()
    await expect(
      b.srv.toConn('ghost').request('confirm', { q: 'x' }, { timeout: 800 }),
    ).rejects.toBeInstanceOf(SocketError)
  })

  it('toConn(id).close() disconnects a client on another process', async () => {
    const a = await node()
    const b = await node()
    const client = h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' }, reconnect: false })
    await client.hello({})
    await waitFor(() => a.srv.local.connections.length === 1)
    const id = a.srv.local.connections[0]!.id

    await waitFor(async () => {
      if (a.srv.local.connections.length > 0) b.srv.toConn(id).close()
      return a.srv.local.connections.length === 0
    }, 10_000)
  })
})
