import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { eq, isIn } from '@super-line/core'
import { inspector } from '@super-line/plugin-inspector'
import { createSuperLineServer, type Conn } from '@super-line/server'
import { auth } from '@super-line/plugin-auth/server'
import { sqliteCollections } from '@super-line/collections-sqlite'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { chat } from './contract.js'
import { memId } from './lib/identity.js'
import type { AuthContext } from '@super-line/plugin-auth'

const PORT = Number(process.env.PORT ?? 8791)
// the durable workspace lives next to this file: examples/collections-chat/collections-chat.db (gitignored)
const DB_FILE = fileURLToPath(new URL('../collections-chat.db', import.meta.url))

const ctxOf = (conn: Conn) => conn.ctx as AuthContext
const server = http.createServer()

// One CollectionStore shared by the server AND the auth kit (so authenticate reads sessions/users from it).
const backend = sqliteCollections({ file: DB_FILE })
// @super-line/plugin-auth owns identity: it adds the users/credentials/sessions collections + the guest role
// (see contract.ts), verifies the session token here, and resolves { role, ctx: { userId, roles, sessionId } }.
const authKit = auth({ contract: chat, collections: backend, defaultRoles: ['user'] })

const srv = createSuperLineServer(chat, {
  transports: [webSocketServerTransport({ server })],
  collections: backend,
  nodeName: 'collections-chat', // friendly name in the Control Center
  plugins: [authKit.plugin, inspector()],
  authenticate: authKit.authenticate, // top-level → clean ctx inference; verifies the session token
  identify: authKit.identify, // principal := userId, so every row policy below keys on the logged-in user

  /*
   * Row-level security — the server-authoritative half TanStack DB can't do on its own. Deny-by-default.
   * `read` returns an IR filter ANDed into every snapshot AND every live change; `write` guards each row op.
   * (The auth plugin locks credentials/sessions and opens the users directory; these are the APP's own rows.)
   */
  policies: {
    // Every channel is publicly visible so you can discover and join it. Anyone may INSERT — no renames/deletes.
    channels: { read: () => undefined, write: (_principal, op) => op === 'insert' },
    // You only ever see and change your OWN membership rows — self-service join/leave.
    memberships: {
      read: (principal) => eq('userId', principal),
      write: (principal, op, next, prev) =>
        op === 'delete' ? prev?.userId === principal : next?.userId === principal,
    },
    // THE headline. Read: only messages in channels you've joined. Write: author AND a member of the channel.
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
    const { userId } = ctx as AuthContext
    if (!userId) return // a guest connection (signing in) — not present, no auto-join
    void onUserConnected(userId).catch((err) => console.error('connect setup failed', err))
  },
  onDisconnect: (conn) => {
    const { userId } = ctxOf(conn)
    const name = userId && nameOf.get(userId)
    if (name) bumpPresence(name, -1)
  },
})

/*
 * Resolve a user's visible channels from their membership rows — server-side, policy-free. The messages read
 * policy calls this on every (re)subscribe (captured at subscribe time; joining re-subscribes automatically).
 */
function memberChannels(userId: string): Promise<string[]> {
  return srv
    .collection('memberships')
    .snapshot({ filter: eq('userId', userId) })
    .then((rows) => rows.map((r) => r.channelId))
}

// On an authenticated connection: resolve the display name for presence, then drop first-timers into #general
// so nobody lands on an empty workspace. The user row itself is created by the auth plugin at sign-up.
const nameOf = new Map<string, string>() // userId → displayName, for the name-keyed presence list
async function onUserConnected(userId: string): Promise<void> {
  const user = await srv.collection('users').read(userId)
  const name = user?.displayName ?? userId
  nameOf.set(userId, name)
  bumpPresence(name, +1)
  if ((await memberChannels(userId)).length === 0) {
    await srv.collection('memberships').insert({ id: memId(userId, 'general'), userId, channelId: 'general' })
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
      const { userId } = ctx as AuthContext
      markTyping(channel, (userId && nameOf.get(userId)) || 'someone')
      return { ok: true }
    },
  },
})

server.listen(PORT, () => {
  console.log(`collections-chat server on ws://localhost:${PORT}`)
  console.log(`  collections: ${DB_FILE}`)
})
