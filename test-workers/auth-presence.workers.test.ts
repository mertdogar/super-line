import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import { createSuperLineClient } from '@super-line/client'
import type { AuthSession, AuthUserPresence } from '@super-line/plugin-auth'
import { waitFor } from '../packages/core/test/wait.js'
import { authApp, stubTransport } from './app.js'
import type { AuthNode } from './worker.js'

// plugin-auth on a hibernating node: a wake builds a new server, so the plugin's boot sweep runs again while the
// sockets stay open. The sweep must spare every session whose connection the wake took back.

const clients: Array<{ close(): void }> = []
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})

type Stub = DurableObjectStub<AuthNode>
const read = <T>(stub: Stub, fn: (server: AuthNode['server']) => Promise<T> | T) => runInDurableObject(stub, (node: AuthNode) => fn(node.server))
const session = async (stub: Stub, id: string) =>
  read(stub, async (s) => (await s.collection('sessions').read(id)) as AuthSession)
const presence = async (stub: Stub, userId: string) =>
  read(stub, async (s) => (await s.collection('userPresence').read(userId)) as AuthUserPresence)

async function signIn(stub: Stub) {
  const guest = createSuperLineClient(authApp, { transport: stubTransport(stub), role: 'guest' })
  const { token, userId } = await guest.signUp({ email: `${crypto.randomUUID()}@example.com`, password: 'passpass', displayName: 'A' })
  guest.close()
  const user = createSuperLineClient(authApp, { transport: stubTransport(stub), role: 'user', params: { token }, reconnectBaseMs: 10 })
  clients.push(user)
  await user.ping()
  const sessions = await read(stub, async (s) => (await s.collection('sessions').snapshot({})) as AuthSession[])
  return { user, userId, sessionId: sessions.find((row) => row.userId === userId && row.endedAt === null)!.id }
}

const freshNode = () => env.AUTH.get(env.AUTH.idFromName(`auth-${crypto.randomUUID()}`))

describe('plugin-auth on a hibernating node', () => {
  it('a session whose socket survives a wake stays open, its user online, until the socket closes', async () => {
    const stub = freshNode()
    const alice = await signIn(stub)
    const opened = await session(stub, alice.sessionId)
    const firstInstance = await read(stub, (s) => s.nodeId)

    await evictDurableObject(stub)
    await alice.user.ping() // wakes a new instance
    await signIn(stub) // authenticating waits for the boot sweep, so it has run

    expect(await read(stub, (s) => s.nodeId)).not.toBe(firstInstance)
    expect(await session(stub, alice.sessionId)).toEqual(opened)
    expect((await presence(stub, alice.userId)).connectedAt).toBe(opened.connectedAt)

    alice.user.close()
    await waitFor(async () => (await session(stub, alice.sessionId)).endedAt !== null)
    const ended = await session(stub, alice.sessionId)
    expect(ended.lastSeenAt).toBeGreaterThan(opened.lastSeenAt) // the close time: no heartbeat ever refreshed it
    expect((await presence(stub, alice.userId)).connectedAt).toBeNull()
  })

  it('a session whose socket did not survive the wake is ended by the boot sweep', async () => {
    const stub = freshNode()
    const alice = await signIn(stub)
    await runInDurableObject(stub, (_node, state) => state.storage.sql.exec('DELETE FROM _sl_conn'))

    await evictDurableObject(stub)
    await expect(alice.user.ping()).rejects.toThrow() // closed 4409: nothing to resume it from

    await waitFor(async () => (await session(stub, alice.sessionId)).endedAt !== null)
  })
})
