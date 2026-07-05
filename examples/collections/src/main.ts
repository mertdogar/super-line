import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { defineContract, eq, isIn, SuperLineError } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { memoryCollections } from '@super-line/collections-memory'
import { superLineCollectionOptions } from '@super-line/tanstack-db'
import { webSocketClientTransport, webSocketServerTransport } from '@super-line/transport-websocket'
import { createCollection, createLiveQueryCollection, eq as teq } from '@tanstack/db'

// Collections are the relational store family (ADR-0006): typed rows declared ON the contract, so the server
// validates every write and both ends share end-to-end types. super-line is the server-authoritative SYNC
// SOURCE; TanStack DB is the client QUERY ENGINE — it owns joins, live queries, and optimistic mutations.
const api = defineContract({
  collections: {
    users: { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' },
    messages: {
      schema: z.object({
        id: z.string(),
        channelId: z.string(),
        authorId: z.string(),
        text: z.string(),
        createdAt: z.number(),
      }),
      key: 'id',
      references: { authorId: 'users' }, // advisory FK metadata (Control Center schema graph + adapter join hints)
    },
  },
  roles: { user: { clientToServer: {} } },
})

type Ctx = { userId: string; channels: string[] }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const code = (e: unknown): string => (e instanceof SuperLineError ? e.code : String(e))

async function main(): Promise<void> {
  const server = http.createServer()
  const srv = createSuperLineServer<typeof api, { role: 'user'; ctx: Ctx }>(api, {
    transports: [webSocketServerTransport({ server })],
    // The handshake carries who you are and which channels you're in.
    authenticate: (h) => ({ role: 'user' as const, ctx: { userId: h.query.userId ?? 'anon', channels: (h.query.channels ?? '').split(',').filter(Boolean) } }),
    identify: (conn) => (conn.ctx as Ctx).userId,
    collections: memoryCollections(),
    // Row-security policies (deny-by-default). `read` returns an IR filter ANDed into every snapshot and live
    // change; `write` guards each row op. This is the server-authoritative half TanStack can't do on its own.
    policies: {
      users: { read: () => undefined, write: () => true }, // the user directory is world-readable
      messages: {
        read: (_principal, ctx) => isIn('channelId', (ctx as Ctx).channels), // you only ever see your channels
        write: (principal, op, next, prev) => (op === 'delete' ? prev?.authorId === principal : next?.authorId === principal), // author-only
      },
    },
  })

  await new Promise<void>((resolve) => server.listen(0, resolve))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`

  // Seed a couple of users and messages (server co-writes bypass policy but are still schema-validated).
  await srv.collection('users').insert({ id: 'alice', name: 'Alice' })
  await srv.collection('users').insert({ id: 'bob', name: 'Bob' })
  await srv.collection('messages').insert({ id: 'm1', channelId: 'general', authorId: 'bob', text: 'hey team', createdAt: 1 })
  await srv.collection('messages').insert({ id: 'm2', channelId: 'random', authorId: 'bob', text: 'anyone up for lunch?', createdAt: 2 })

  // Alice connects — she's only in #general.
  const alice = createSuperLineClient(api, {
    transport: webSocketClientTransport({ url }),
    role: 'user',
    params: { userId: 'alice', channels: 'general' },
  })

  // Build TanStack DB collections backed by super-line. `users` syncs whole; `messages` pushes a per-channel
  // subset predicate to the server (only #general rows cross the wire for Alice).
  const users = createCollection(superLineCollectionOptions(alice, api, 'users'))
  const messages = createCollection(superLineCollectionOptions(alice, api, 'messages', { query: { filter: eq('channelId', 'general') } }))
  await users.preload()
  await messages.preload()

  // The headline: a client-side JOIN of two synced collections, denormalizing author names onto messages.
  const feed = createLiveQueryCollection((q) =>
    q
      .from({ m: messages })
      .join({ u: users }, ({ m, u }) => teq(u.id, m.authorId), 'inner')
      .select(({ m, u }) => ({ id: m.id, text: m.text, author: u.name })),
  )
  await feed.preload()

  const render = (label: string): void => console.log(label, feed.toArray.map((r) => `${r.author}: ${r.text}`))
  render("alice's #general feed →") // [ 'Bob: hey team' ] — #random was never synced (RLS pushdown)

  // Alice posts optimistically; the row shows locally at once, then persists + syncs back through the join.
  console.log('\nalice posts to #general…')
  const tx = messages.insert({ id: 'm3', channelId: 'general', authorId: 'alice', text: 'morning!', createdAt: 3 })
  render('  optimistic feed →') // already includes 'Alice: morning!'
  await tx.isPersisted.promise
  await sleep(50)
  render('  after server sync →')

  // The write policy is author-only: Alice cannot post AS Bob → the optimistic insert rolls back.
  console.log('\nalice tries to post as bob…')
  await messages
    .insert({ id: 'm4', channelId: 'general', authorId: 'bob', text: 'impersonated', createdAt: 4 })
    .isPersisted.promise.catch((e) => console.log('  denied:', code(e)))
  await sleep(50)
  render('  feed unchanged →')

  // A message posted server-side to a channel Alice isn't in never reaches her (RLS on the live path too).
  console.log('\nserver posts to #random (alice is not a member)…')
  await srv.collection('messages').insert({ id: 'm5', channelId: 'random', authorId: 'bob', text: 'secret', createdAt: 5 })
  await sleep(50)
  render('  alice still sees only #general →')

  alice.close()
  await srv.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

// In a React app you'd swap the manual createLiveQueryCollection for the `useLiveQuery` hook from
// @tanstack/react-db (same query builder), and useCollection from @super-line/react for simple filtered lists.
void main()
