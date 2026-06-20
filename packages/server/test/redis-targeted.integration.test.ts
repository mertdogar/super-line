import { execSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { defineContract, SuperLineError } from '@super-line/core'
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
  const n = await h.server(contract, { authenticate: auth, identify, adapter: createRedisAdapter(redisUrl) })
  n.srv.implement({ shared: { hello: async () => ({ ok: true }) }, user: {} })
  return n
}

describe.skipIf(!dockerAvailable)('redis targeted send + server→client request cross-process (slices 5/6)', () => {
  it('toUser(uid).emit reaches a client held by another process', async () => {
    const a = await node()
    const b = await node()
    const client = h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    const got: Array<{ text: string }> = []
    client.on('notice', (m) => got.push(m))
    await client.hello({})
    await waitFor(async () => (await b.srv.cluster.count()) === 1, 5000)

    // tolerate the c:{id} SUBSCRIBE propagation window (real apps don't send in the same ms as connect)
    await waitFor(async () => {
      if (got.length === 0) b.srv.toUser('u1').emit('notice', { text: 'cross' })
      return got.length > 0
    }, 5000)
    expect(got[0]).toEqual({ text: 'cross' })
  })

  it('toConn(id).request round-trips across processes', async () => {
    const a = await node()
    const b = await node()
    const client = h.client(contract, { url: a.url, role: 'user', params: { uid: 'u1' } })
    client.implement({ confirm: async ({ q }) => ({ ok: q === 'go' }) })
    await client.hello({})
    await waitFor(async () => (await b.srv.cluster.count()) === 1, 5000)

    const [c] = await b.srv.cluster.byUser('u1')
    const answer = await b.srv.toConn(c!.id).request('confirm', { q: 'go' }, { timeout: 5000 })
    expect(answer).toEqual({ ok: true })
  })

  it('toConn(id).request rejects TIMEOUT when no process owns the id', async () => {
    const b = await node()
    await expect(
      b.srv.toConn('ghost').request('confirm', { q: 'x' }, { timeout: 800 }),
    ).rejects.toBeInstanceOf(SuperLineError)
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
    }, 5000)
  })
})
