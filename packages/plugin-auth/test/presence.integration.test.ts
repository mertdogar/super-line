import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createSuperLineClient } from '@super-line/client'
import { memoryCollections } from '@super-line/collections-memory'
import { authContract, type AuthSession, type AuthUserPresence } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { createInMemoryAdapter, createSuperLineServer, MemoryBus } from '@super-line/server'
import { createLoopbackTransport } from '@super-line/transport-loopback'

const app = defineContract({
  roles: {
    user: { clientToServer: { ping: { input: z.void(), output: z.object({ ok: z.boolean() }) } } },
  },
  plugins: [authContract()],
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('plugin-auth connection sessions', () => {
  it('creates and ends one session for an access-token connection', async () => {
    const collections = memoryCollections()
    const loopback = createLoopbackTransport()
    const authKit = auth({ contract: app, collections })
    const server = createSuperLineServer(app, {
      nodeKey: 'auth-presence-test',
      transports: [loopback.server],
      collections,
      authenticate: authKit.authenticate,
      identify: authKit.identify,
      plugins: [authKit.plugin],
      heartbeat: { interval: 15 },
    })
    cleanups.push(() => server.close())
    server.implement({ user: { ping: async () => ({ ok: true }) } })

    const guest = createSuperLineClient(app, { transport: loopback.client(), role: 'guest' })
    cleanups.unshift(() => guest.close())
    const identity = await guest.signUp({ email: 'a@example.com', password: 'passpass', displayName: 'A' })
    guest.close()

    const user = createSuperLineClient(app, {
      transport: loopback.client(),
      role: 'user',
      params: { token: identity.token },
    })
    cleanups.unshift(() => user.close())
    await user.ping()

    const [session] = (await server.collection('sessions').snapshot({})) as AuthSession[]
    expect(session).toMatchObject({
      id: server.local.connections[0]?.id,
      userId: identity.userId,
      nodeKey: 'auth-presence-test',
      authMethod: 'access-token',
      endedAt: null,
    })
    await waitFor(async () => {
      const fresh = (await server.collection('sessions').read(session!.id)) as AuthSession
      return fresh.lastSeenAt > fresh.connectedAt
    })

    user.close()
    await waitFor(async () => ((await server.collection('sessions').read(session!.id)) as AuthSession).endedAt !== null)

    const reconnected = createSuperLineClient(app, {
      transport: loopback.client(),
      role: 'user',
      params: { token: identity.token },
    })
    cleanups.unshift(() => reconnected.close())
    await reconnected.ping()
    const history = (await server.collection('sessions').snapshot({})) as AuthSession[]
    expect(history).toHaveLength(2)
    expect(new Set(history.map((row) => row.id)).size).toBe(2)
  })

  it('keeps presence online until the last concurrent session ends', async () => {
    const collections = memoryCollections()
    const loopback = createLoopbackTransport()
    const authKit = auth({ contract: app, collections })
    const server = createSuperLineServer(app, {
      nodeKey: 'auth-concurrent-test',
      transports: [loopback.server],
      collections,
      authenticate: authKit.authenticate,
      identify: authKit.identify,
      plugins: [authKit.plugin],
    })
    cleanups.push(() => server.close())
    server.implement({ user: { ping: async () => ({ ok: true }) } })
    const guest = createSuperLineClient(app, { transport: loopback.client(), role: 'guest' })
    const identity = await guest.signUp({ email: 'two@example.com', password: 'passpass', displayName: 'Two' })
    guest.close()
    const first = createSuperLineClient(app, { transport: loopback.client(), role: 'user', params: { token: identity.token } })
    cleanups.unshift(() => first.close())
    await first.ping()
    const second = createSuperLineClient(app, { transport: loopback.client(), role: 'user', params: { token: identity.token } })
    cleanups.unshift(() => second.close())
    await second.ping()

    const sessions = (await server.collection('sessions').snapshot({})) as AuthSession[]
    expect(sessions).toHaveLength(2)
    first.close()
    await waitFor(async () => {
      const rows = (await server.collection('sessions').snapshot({})) as AuthSession[]
      return rows.filter((row) => row.endedAt === null).length === 1
    })
    expect((await server.collection('userPresence').read(identity.userId)) as AuthUserPresence).toMatchObject({
      connectedAt: expect.any(Number),
      lastSeenAt: expect.any(Number),
    })

    second.close()
    await waitFor(async () => {
      const row = (await server.collection('userPresence').read(identity.userId)) as AuthUserPresence
      return row.connectedAt === null
    })
  })

  it('aggregates sessions owned by different server nodes', async () => {
    const bus = new MemoryBus()
    const collectionsA = memoryCollections()
    const collectionsB = memoryCollections()
    const loopbackA = createLoopbackTransport()
    const loopbackB = createLoopbackTransport()
    const authA = auth({ contract: app, collections: collectionsA })
    const authB = auth({ contract: app, collections: collectionsB })
    const serverA = createSuperLineServer(app, {
      nodeKey: 'presence-node-a',
      transports: [loopbackA.server],
      adapter: createInMemoryAdapter(bus),
      collections: collectionsA,
      authenticate: authA.authenticate,
      identify: authA.identify,
      plugins: [authA.plugin],
    })
    const serverB = createSuperLineServer(app, {
      nodeKey: 'presence-node-b',
      transports: [loopbackB.server],
      adapter: createInMemoryAdapter(bus),
      collections: collectionsB,
      authenticate: authB.authenticate,
      identify: authB.identify,
      plugins: [authB.plugin],
    })
    cleanups.push(() => serverA.close(), () => serverB.close())
    serverA.implement({ user: { ping: async () => ({ ok: true }) } })
    serverB.implement({ user: { ping: async () => ({ ok: true }) } })
    const profile = await authA.users.create({ displayName: 'Two Nodes' })
    const key = await authA.apiKeys.create(profile.id, { role: 'user', label: 'shared' })
    await waitFor(async () => (await serverB.collection('apiKeys').read(key.id)) !== undefined)
    const clientA = createSuperLineClient(app, { transport: loopbackA.client(), role: 'user', params: { apiKey: key.key } })
    const clientB = createSuperLineClient(app, { transport: loopbackB.client(), role: 'user', params: { apiKey: key.key } })
    cleanups.unshift(() => clientA.close(), () => clientB.close())
    await Promise.all([clientA.ping(), clientB.ping()])

    const sessions = (await serverA.collection('sessions').snapshot({})) as AuthSession[]
    expect(new Set(sessions.map((row) => row.nodeKey))).toEqual(new Set(['presence-node-a', 'presence-node-b']))
    clientA.close()
    clientB.close()
    await waitFor(async () => {
      const row = (await serverA.collection('userPresence').read(profile.id)) as AuthUserPresence
      return row.connectedAt === null
    })
    const ended = (await serverA.collection('sessions').snapshot({})) as AuthSession[]
    expect(ended.every((row) => row.endedAt !== null)).toBe(true)
  })

  it('records API-key provenance without creating an email credential', async () => {
    const collections = memoryCollections()
    const loopback = createLoopbackTransport()
    const authKit = auth({ contract: app, collections })
    const server = createSuperLineServer(app, {
      nodeKey: 'auth-api-key-test',
      transports: [loopback.server],
      collections,
      authenticate: authKit.authenticate,
      identify: authKit.identify,
      plugins: [authKit.plugin],
    })
    cleanups.push(() => server.close())
    server.implement({ user: { ping: async () => ({ ok: true }) } })
    const agent = await authKit.users.create({ displayName: 'Agent' })
    const key = await authKit.apiKeys.create(agent.id, { role: 'user', label: 'agent' })
    const client = createSuperLineClient(app, { transport: loopback.client(), role: 'user', params: { apiKey: key.key } })
    cleanups.unshift(() => client.close())
    await client.ping()

    const sessions = (await server.collection('sessions').snapshot({})) as AuthSession[]
    expect(sessions).toMatchObject([{ userId: agent.id, authMethod: 'api-key', authId: key.id, endedAt: null }])
    expect(await server.collection('credentials').snapshot({})).toEqual([])

    await server.close()
    expect(((await server.collection('sessions').read(sessions[0]!.id)) as AuthSession).endedAt).toEqual(expect.any(Number))
  })

  it('ends unfinished sessions owned by the same node key on boot', async () => {
    const collections = memoryCollections()
    const seedLoopback = createLoopbackTransport()
    const seedAuth = auth({ contract: app, collections })
    const seed = createSuperLineServer(app, {
      nodeKey: 'seed-node',
      transports: [seedLoopback.server],
      collections,
      authenticate: seedAuth.authenticate,
      plugins: [seedAuth.plugin],
    })
    const stale: AuthSession = {
      id: 'stale-session',
      userId: 'stale-user',
      nodeId: 'crashed-process',
      nodeKey: 'recovering-node',
      role: 'user',
      transport: 'websocket',
      authMethod: 'api-key',
      authId: 'key-id',
      connectedAt: 1,
      lastSeenAt: 2,
      endedAt: null,
    }
    const otherNode = { ...stale, id: 'other-node-session', nodeKey: 'other-node' }
    await seed.collection('sessions').insert(stale)
    await seed.collection('sessions').insert(otherNode)
    await seed.close()

    const recoveryLoopback = createLoopbackTransport()
    const recoveryAuth = auth({ contract: app, collections })
    const recovery = createSuperLineServer(app, {
      nodeKey: 'recovering-node',
      transports: [recoveryLoopback.server],
      collections,
      authenticate: recoveryAuth.authenticate,
      plugins: [recoveryAuth.plugin],
    })
    cleanups.push(() => recovery.close())

    await waitFor(async () => ((await recovery.collection('sessions').read(stale.id)) as AuthSession).endedAt !== null)
    expect(((await recovery.collection('sessions').read(stale.id)) as AuthSession).lastSeenAt).toBe(2)
    expect(((await recovery.collection('sessions').read(otherNode.id)) as AuthSession).endedAt).toBeNull()
  })

  it('drains in-flight authentication before the graceful shutdown session sweep', async () => {
    const base = memoryCollections()
    let blockAccessTokenRead = false
    let releaseRead!: () => void
    let markReadStarted!: () => void
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve))
    const readStarted = new Promise<void>((resolve) => (markReadStarted = resolve))
    const collections = {
      ...base,
      read: async (name: string, id: string) => {
        if (blockAccessTokenRead && name === 'accessTokens') {
          markReadStarted()
          await readGate
        }
        return base.read(name, id)
      },
    }
    const loopback = createLoopbackTransport()
    const authKit = auth({ contract: app, collections })
    const server = createSuperLineServer(app, {
      nodeKey: 'auth-shutdown-test',
      transports: [loopback.server],
      collections,
      authenticate: authKit.authenticate,
      identify: authKit.identify,
      plugins: [authKit.plugin],
    })
    cleanups.push(() => server.close())
    server.implement({ user: { ping: async () => ({ ok: true }) } })
    const guest = createSuperLineClient(app, { transport: loopback.client(), role: 'guest' })
    const identity = await guest.signUp({ email: 'shutdown@example.com', password: 'passpass', displayName: 'Shutdown' })
    guest.close()

    blockAccessTokenRead = true
    const user = createSuperLineClient(app, {
      transport: loopback.client(),
      role: 'user',
      params: { token: identity.token },
      reconnect: false,
    })
    cleanups.unshift(() => user.close())
    const request = user.ping().catch(() => undefined)
    await readStarted
    const closing = server.close()
    releaseRead()
    await Promise.all([request, closing])

    expect(await base.snapshot('sessions', {})).toEqual([])
  })
})

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 2000): Promise<void> {
  const startedAt = Date.now()
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeout) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
