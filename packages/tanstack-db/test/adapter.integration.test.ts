import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, eq as slFilter } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'
import { memoryCollections } from '@super-line/collections-memory'
import { createCollection, createLiveQueryCollection, eq } from '@tanstack/db'
import { superLineCollectionOptions } from '@super-line/tanstack-db'

const contract = defineContract({
  collections: {
    users: { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' },
    messages: {
      schema: z.object({ id: z.string(), channelId: z.string(), authorId: z.string(), text: z.string(), createdAt: z.number() }),
      key: 'id',
      references: { authorId: 'users' },
    },
  },
  roles: { user: { clientToServer: { noop: { input: z.void(), output: z.void() } } } },
})

type Ctx = { userId: string }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function harness() {
  const httpServer = http.createServer()
  const srv = createSuperLineServer<typeof contract, { role: 'user'; ctx: Ctx }>(contract, {
    transports: [webSocketServerTransport({ server: httpServer })],
    authenticate: (h) => ({ role: 'user' as const, ctx: { userId: h.query.userId ?? 'anon' } }),
    identify: (conn) => (conn.ctx as Ctx).userId,
    collections: memoryCollections(),
    policies: {
      users: { read: () => undefined, write: () => true },
      messages: { read: () => undefined, write: () => true },
    },
  })
  await new Promise<void>((r) => httpServer.listen(0, r))
  const { port } = httpServer.address() as AddressInfo
  const client = createSuperLineClient(contract, {
    transport: webSocketClientTransport({ url: `ws://127.0.0.1:${port}` }),
    role: 'user',
    params: { userId: 'u1' },
  })
  cleanups.unshift(() => client.close())
  cleanups.push(async () => {
    await srv.close()
    await new Promise<void>((r) => httpServer.close(() => r()))
  })
  return { srv, client }
}

const waitFor = async (pred: () => boolean | Promise<boolean>, timeout = 2000): Promise<void> => {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('@super-line/tanstack-db adapter', () => {
  it('syncs a filtered subset into a TanStack collection and joins it client-side', async () => {
    const { srv, client } = await harness()
    await srv.collection('users').insert({ id: 'u1', name: 'Ada' })
    await srv.collection('messages').insert({ id: 'm1', channelId: 'general', authorId: 'u1', text: 'hello', createdAt: 1 })
    await srv.collection('messages').insert({ id: 'm2', channelId: 'random', authorId: 'u1', text: 'offtopic', createdAt: 2 })

    const users = createCollection(superLineCollectionOptions(client, contract, 'users'))
    const messages = createCollection(
      superLineCollectionOptions(client, contract, 'messages', { query: { filter: slFilter('channelId', 'general') } }),
    )
    await users.preload()
    await messages.preload()

    // only the 'general' subset synced (server-side predicate pushdown)
    expect(messages.toArray.map((m) => m.id).sort()).toEqual(['m1'])

    // client-side join across two synced collections — the headline
    const joined = createLiveQueryCollection((q) =>
      q
        .from({ m: messages })
        .join({ u: users }, ({ m, u }) => eq(u.id, m.authorId), 'inner')
        .select(({ m, u }) => ({ id: m.id, text: m.text, author: u.name })),
    )
    await joined.preload()
    expect(joined.toArray).toEqual([{ id: 'm1', text: 'hello', author: 'Ada' }])
  })

  it('an optimistic insert persists on the server and syncs back through the join', async () => {
    const { srv, client } = await harness()
    await srv.collection('users').insert({ id: 'u1', name: 'Ada' })

    const users = createCollection(superLineCollectionOptions(client, contract, 'users'))
    const messages = createCollection(
      superLineCollectionOptions(client, contract, 'messages', { query: { filter: slFilter('channelId', 'general') } }),
    )
    await users.preload()
    await messages.preload()

    const tx = messages.insert({ id: 'm9', channelId: 'general', authorId: 'u1', text: 'optimistic', createdAt: 9 })
    expect(messages.get('m9')?.text).toBe('optimistic') // applied optimistically, before the ack
    await tx.isPersisted.promise // server accepted the batch

    expect(await srv.collection('messages').read('m9')).toMatchObject({ text: 'optimistic' }) // durable on the server
    await waitFor(() => messages.get('m9') !== undefined) // and confirmed back through sync
  })
})
