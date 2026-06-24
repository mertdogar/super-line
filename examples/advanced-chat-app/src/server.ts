import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { SuperLineError } from '@super-line/core'
import { createSuperLineServer, type Conn } from '@super-line/server'
import { sqliteStoreServer } from '@super-line/store-sqlite'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { chat, type Channel, type ChannelsDoc, type MessagesDoc } from './contract.js'

const PORT = Number(process.env.PORT ?? 8790)
// the durable workspace lives next to this file: examples/advanced-chat-app/chat.db (gitignored)
const DB_FILE = fileURLToPath(new URL('../chat.db', import.meta.url))

/*
 * Open-workspace ACL. Stores are deny-by-default and the read check runs ONCE at open time, so we
 * give every connection the SAME principal and create every Resource granting it read. The server
 * is the SOLE writer (clients only read via useResource), so one shared grant means every client's
 * `open` succeeds with no per-connection grant race.
 */
const WORKSPACE = 'workspace'
const READABLE = { [WORKSPACE]: { read: true, write: false } }

const CHANNELS = 'channels' // the index Resource id
const msgKey = (id: string) => `messages:${id}`
const slug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

interface Ctx {
  name: string
}
const nameOf = (conn: Conn) => (conn.ctx as Ctx).name

const server = http.createServer()

const srv = createSuperLineServer(chat, {
  transports: [webSocketServerTransport({ server })],
  stores: { chat: sqliteStoreServer({ file: DB_FILE }) },
  authenticate: (h) => {
    const name = h.query.name?.trim()
    if (!name) throw new Error('name is required')
    return { role: 'user' as const, ctx: { name } satisfies Ctx }
  },
  identify: () => WORKSPACE, // shared store-read principal (see ACL note above)
  onConnection: (conn) => bumpPresence(nameOf(conn), +1),
  onDisconnect: (conn) => bumpPresence(nameOf(conn), -1),
})

const store = srv.store('chat')

/*
 * Serialize read-modify-write per resource key. A store write replaces the WHOLE document (LWW), and
 * the server dispatches request handlers concurrently — so two overlapping appends to the same
 * Resource (`read` the array → spread → `write`) would clobber each other and silently drop a
 * message/channel. Chaining each key's mutations fixes that; different keys still run in parallel.
 */
const chains = new Map<string, Promise<unknown>>()
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn)
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

// ---- presence: ephemeral, name-keyed online counts (a name may have several tabs) ----
const online = new Map<string, number>()
function bumpPresence(name: string, delta: number): void {
  const next = (online.get(name) ?? 0) + delta
  if (next <= 0) online.delete(name)
  else online.set(name, next)
  publishPresence()
}
function publishPresence(): void {
  srv.forRole('user').publish('presence', { users: [...online.keys()].sort() })
}

// ---- typing: ephemeral, per-channel, auto-expiring ----
const TYPING_TTL = 4000
const typing = new Map<string, Map<string, ReturnType<typeof setTimeout>>>()
function publishTyping(): void {
  const byChannel: Record<string, string[]> = {}
  for (const [ch, users] of typing) if (users.size) byChannel[ch] = [...users.keys()].sort()
  srv.forRole('user').publish('typing', { byChannel })
}
function clearTyping(channel: string, name: string): void {
  const users = typing.get(channel)
  if (!users?.has(name)) return
  clearTimeout(users.get(name))
  users.delete(name)
  if (!users.size) typing.delete(channel)
  publishTyping()
}
function markTyping(channel: string, name: string): void {
  let users = typing.get(channel)
  if (!users) typing.set(channel, (users = new Map()))
  clearTimeout(users.get(name))
  users.set(
    name,
    setTimeout(() => {
      const u = typing.get(channel)
      u?.delete(name)
      if (u && !u.size) typing.delete(channel)
      publishTyping()
    }, TYPING_TTL),
  )
  publishTyping()
}

// ---- seed the default workspace once; on restart the data is already in SQLite ----
if (!(await store.read(CHANNELS))) {
  const general: Channel = { id: 'general', name: 'general', createdAt: Date.now() }
  await store.create(msgKey(general.id), { items: [] } satisfies MessagesDoc, READABLE)
  await store.create(CHANNELS, { channels: [general] } satisfies ChannelsDoc, READABLE)
}

srv.implement({
  user: {
    hello: async () => ({ users: [...online.keys()].sort() }),

    createChannel: async ({ name }) => {
      const id = slug(name)
      if (!id) throw new SuperLineError('BAD_REQUEST', 'channel name is empty')
      // serialize on the index so concurrent creates can't drop a channel (orphaning its messages)
      return serialize(CHANNELS, async () => {
        if (await store.read(msgKey(id))) throw new SuperLineError('CONFLICT', `#${id} already exists`)
        await store.create(msgKey(id), { items: [] } satisfies MessagesDoc, READABLE)
        const index = (await store.read(CHANNELS))?.data as ChannelsDoc
        const channel: Channel = { id, name: name.trim(), createdAt: Date.now() }
        // writing the index fans out to every subscribed sidebar
        await store.write(CHANNELS, { channels: [...index.channels, channel] } satisfies ChannelsDoc)
        return { id }
      })
    },

    send: async ({ channel, text }, ctx) => {
      const trimmed = text.trim()
      if (!trimmed) throw new SuperLineError('BAD_REQUEST', 'empty message')
      // serialize on the channel so concurrent sends can't clobber each other's appended message
      return serialize(msgKey(channel), async () => {
        const res = await store.read(msgKey(channel))
        if (!res) throw new SuperLineError('NOT_FOUND', `no channel #${channel}`)
        const msg = { id: randomUUID(), from: ctx.name, text: trimmed, at: Date.now() }
        const doc = res.data as MessagesDoc
        await store.write(msgKey(channel), { items: [...doc.items, msg] } satisfies MessagesDoc)
        clearTyping(channel, ctx.name)
        return { id: msg.id }
      })
    },

    typing: async ({ channel }, ctx) => {
      markTyping(channel, ctx.name)
      return { ok: true }
    },
  },
})

server.listen(PORT, () => {
  console.log(`advanced-chat server on ws://localhost:${PORT}`)
  console.log(`  store: ${DB_FILE}`)
})
