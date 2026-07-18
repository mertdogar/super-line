import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { inspector } from '@super-line/plugin-inspector'
import { createSuperLineServer, type Conn } from '@super-line/server'
import { auth } from '@super-line/plugin-auth/server'
import { chat as chatKitFactory } from '@super-line/plugin-chat/server'
import { sqliteCollections } from '@super-line/collections-sqlite'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { chat } from './contract.js'
import { seedChannels, startAgent } from './agent.js'
import type { AuthContext } from '@super-line/plugin-auth'

const PORT = Number(process.env.PORT ?? 8791)
// the durable workspace lives next to this file: examples/collections-chat/collections-chat.db (gitignored)
const DB_FILE = fileURLToPath(new URL('../collections-chat.db', import.meta.url))

const ctxOf = (conn: Conn) => conn.ctx as AuthContext
const server = http.createServer()

// One CollectionStore shared by the server AND the auth kit (so authenticate reads sessions/users from it).
const backend = sqliteCollections({ file: DB_FILE, collections: chat.collections })

// plugin-auth owns identity (users/credentials/sessions + the guest role). plugin-chat owns the whole
// chat model: its policies (read-RLS, write-deny) and 20 request handlers ship INSIDE chatKit.plugin —
// this file has NO hand-rolled channel/message policies or handlers anymore.
const authKit = auth({ contract: chat, collections: backend, defaultRoles: ['user'] })
const chatKit = chatKitFactory({
  contract: chat,
  hooks: {
    // a domain-layer hook: trim + reject empty message bodies, for client AND agent sends alike
    sendMessage: {
      before: (input) => {
        const content = typeof input.content === 'string' ? input.content.trim() : input.content
        if (!content) throw new Error('empty message')
        return { ...input, content }
      },
    },
  },
})

const srv = createSuperLineServer(chat, {
  transports: [webSocketServerTransport({ server })],
  collections: backend,
  nodeName: 'collections-chat',
  plugins: [authKit.plugin, chatKit.plugin, inspector()],
  authenticate: authKit.authenticate,
  identify: authKit.identify, // principal := userId, so plugin-chat's read policies key on the logged-in user

  onConnection: (_conn, ctx) => {
    const { userId } = ctx as AuthContext
    if (!userId) return
    void onUserConnected(userId).catch((err) => console.error('connect setup failed', err))
  },
  onDisconnect: (conn) => {
    const { userId } = ctxOf(conn)
    const name = userId && nameOf.get(userId)
    if (name) bumpPresence(name, -1)
  },
})

// On an authenticated connection: resolve the display name for presence, then drop first-timers into the
// public channels + the AI channel so nobody lands on an empty workspace. Membership is a chat-kit call now.
const nameOf = new Map<string, string>()
async function onUserConnected(userId: string): Promise<void> {
  const user = await srv.collection('users').read(userId)
  const name = user?.displayName ?? userId
  nameOf.set(userId, name)
  bumpPresence(name, +1)
  if ((await chatKit.members.channelsOf(userId)).length === 0) {
    for (const ch of await seededPublicChannels()) {
      await chatKit.members.add(ch.id, userId).catch(() => {}) // idempotent-ish: ignore a racing dup
    }
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

// ---- typing: ephemeral, per-channel, auto-expiring ----
const TYPING_TTL = 4000
const typing = new Map<string, Map<string, ReturnType<typeof setTimeout>>>()
function publishTyping(): void {
  const byChannel: Record<string, string[]> = {}
  for (const [ch, users] of typing) if (users.size) byChannel[ch] = [...users.keys()].sort()
  srv.forRole('user').publish('typing', { byChannel })
}
function markTyping(channelId: string, name: string): void {
  let users = typing.get(channelId)
  if (!users) typing.set(channelId, (users = new Map()))
  clearTimeout(users.get(name))
  users.set(
    name,
    setTimeout(() => {
      const u = typing.get(channelId)
      u?.delete(name)
      if (u && !u.size) typing.delete(channelId)
      publishTyping()
    }, TYPING_TTL),
  )
  publishTyping()
}

// ---- seed the public channels + AI channel once via the imperative kit (server-authoritative) ----
// Channel ids are server-generated UUIDs, so "already seeded?" is a find-by-name (this example's channel
// names are unique by construction).
async function seededPublicChannels() {
  return chatKit.channels.find()
}
async function seed(): Promise<void> {
  const existing = new Set((await chatKit.channels.find()).map((c) => c.name))
  for (const name of ['general', 'random']) {
    if (!existing.has(name)) await chatKit.channels.create({ name })
  }
}

srv.implement({
  user: {
    hello: async () => ({ users: [...online.keys()].sort() }),
    typing: async ({ channelId }, ctx) => {
      const { userId } = ctx as AuthContext
      markTyping(channelId, (userId && nameOf.get(userId)) || 'someone')
      return { ok: true }
    },
  },
})

await seed()
await seedChannels(chatKit) // ensure the agent's channel exists before the bot connects

server.listen(PORT, async () => {
  console.log(`collections-chat server on ws://localhost:${PORT}`)
  console.log(`  collections: ${DB_FILE}`)
  // The AI agent is a REAL user: provisioned via authKit, connecting over WS with its own API key.
  await startAgent({ authKit, chatKit, url: `ws://localhost:${PORT}` }).catch((err) =>
    console.error('agent failed to start', err),
  )
})
