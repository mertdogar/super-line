import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { eq, isIn } from '@super-line/core'
import { inspector } from '@super-line/plugin-inspector'
import { createSuperLineServer, type Conn } from '@super-line/server'
import { sqliteCollections } from '@super-line/collections-sqlite'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { chat } from './contract.js'
import { memId, slug } from './lib/identity.js'

const PORT = Number(process.env.PORT ?? 8791)
// the durable workspace lives next to this file: examples/collections-chat/collections-chat.db (gitignored)
const DB_FILE = fileURLToPath(new URL('../collections-chat.db', import.meta.url))

interface Ctx {
  userId: string
  name: string
}
const ctxOf = (conn: Conn) => conn.ctx as Ctx

const server = http.createServer()

const srv = createSuperLineServer(chat, {
  transports: [webSocketServerTransport({ server })],
  collections: sqliteCollections({ file: DB_FILE }),
  nodeName: 'collections-chat', // friendly name in the Control Center
  plugins: [inspector()],
  authenticate: (h) => {
    const name = h.query.name?.trim()
    if (!name) throw new Error('name is required')
    return { role: 'user' as const, ctx: { userId: slug(name), name } satisfies Ctx }
  },
  // the principal drives every row policy below
  identify: (conn) => ctxOf(conn).userId,

  /*
   * Row-level security — the server-authoritative half TanStack DB can't do on its own. Deny-by-default:
   * a collection with no `read` can't be read, no `write` can't be written. `read` returns an IR filter
   * ANDed into every snapshot AND every live change; `write` guards each row op (return false → the whole
   * optimistic batch rolls back on the client).
   */
  policies: {
    // The user directory is world-readable (the client needs it for the messages⋈users author join).
    // No `write` ⇒ clients can't write it; the server upserts your row on connect (see register()).
    users: { read: () => undefined },

    // Every channel is publicly visible so you can discover and join it. Anyone may create one, but
    // clients can only INSERT — no renames/deletes over the wire.
    channels: { read: () => undefined, write: (_principal, op) => op === 'insert' },

    // You only ever see and change your OWN membership rows — self-service join/leave.
    memberships: {
      read: (principal) => eq('userId', principal),
      write: (principal, op, next, prev) =>
        op === 'delete' ? prev?.userId === principal : next?.userId === principal,
    },

    // THE headline. Read: only messages in channels you've joined, resolved from your membership rows.
    // Write: you must be the author AND a member of the channel (both checks — the second one queries the
    // memberships collection). Either way an illegal optimistic insert rolls back on the client.
    messages: {
      read: async (principal) => isIn('channelId', await memberChannels(principal)),
      write: async (principal, op, next, prev) => {
        const row = op === 'delete' ? prev : next
        if (!row || row.authorId !== principal) return false
        return (await memberChannels(principal)).includes(row.channelId)
      },
    },
  },

  onConnection: (_conn, ctx) => {
    const c = ctx as Ctx
    bumpPresence(c.name, +1)
    // upsert + auto-join is async; onConnection isn't awaited, so run it fire-and-forget with a catch
    void register(c).catch((err) => console.error('connect setup failed', err))
  },
  onDisconnect: (conn) => bumpPresence(ctxOf(conn).name, -1),
})

/*
 * Resolve a user's visible channels from their membership rows — server-side, policy-free. The messages
 * read policy calls this on every (re)subscribe. It's captured at subscribe time, so joining a channel
 * needs the client to re-subscribe (which it does automatically — see the README's "how RLS re-subscribes").
 */
function memberChannels(userId: string): Promise<string[]> {
  return srv
    .collection('memberships')
    .snapshot({ filter: eq('userId', userId) })
    .then((rows) => rows.map((r) => r.channelId))
}

// Upsert the connecting user into the directory, and drop first-timers into #general so nobody lands on
// an empty workspace. Server co-writes bypass row policy but are still schema-validated.
async function register(c: Ctx): Promise<void> {
  const existing = await srv.collection('users').read(c.userId)
  if (!existing) await srv.collection('users').insert({ id: c.userId, name: c.name })
  else if (existing.name !== c.name) await srv.collection('users').update({ id: c.userId, name: c.name })

  if ((await memberChannels(c.userId)).length === 0) {
    await srv.collection('memberships').insert({ id: memId(c.userId, 'general'), userId: c.userId, channelId: 'general' })
  }
}

// ---- presence: ephemeral, name-keyed online counts (a name may have several tabs) ----
const online = new Map<string, number>()
function bumpPresence(name: string, delta: number): void {
  const next = (online.get(name) ?? 0) + delta
  if (next <= 0) online.delete(name)
  else online.set(name, next)
  srv.forRole('user').publish('presence', { users: [...online.keys()].sort() })
}

// ---- typing: ephemeral, per-channel, auto-expiring (durable state is collections; signals stay topics) ----
const TYPING_TTL = 4000
const typing = new Map<string, Map<string, ReturnType<typeof setTimeout>>>()
function publishTyping(): void {
  const byChannel: Record<string, string[]> = {}
  for (const [ch, users] of typing) if (users.size) byChannel[ch] = [...users.keys()].sort()
  srv.forRole('user').publish('typing', { byChannel })
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

// ---- seed the public channels once; on restart they're already in SQLite ----
for (const id of ['general', 'random']) {
  if (!(await srv.collection('channels').read(id))) {
    await srv.collection('channels').insert({ id, name: id, createdAt: Date.now() })
  }
}

srv.implement({
  user: {
    hello: async () => ({ users: [...online.keys()].sort() }),
    typing: async ({ channel }, ctx) => {
      markTyping(channel, (ctx as Ctx).name)
      return { ok: true }
    },
  },
})

server.listen(PORT, () => {
  console.log(`collections-chat server on ws://localhost:${PORT}`)
  console.log(`  collections: ${DB_FILE}`)
})
