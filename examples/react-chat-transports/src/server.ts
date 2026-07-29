import http from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { inspector } from '@super-line/plugin-inspector'
import { createSuperLineServer } from '@super-line/server'
import { auth } from '@super-line/plugin-auth/server'
import { chat as chatKitFactory } from '@super-line/plugin-chat/server'
import { sqliteCollections } from '@super-line/collections-sqlite'
import { pgliteCollections } from '@super-line/collections-pglite'
import { crdtMemoryCollections } from '@super-line/collections-crdt-memory'
import { crdtPgliteCollections } from '@super-line/collections-crdt-pglite'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { httpServerTransport } from '@super-line/transport-http'
import { libp2pServerTransport } from '@super-line/transport-libp2p'
import type { DocOptions } from '@super-line/core'
import type { AuthContext } from '@super-line/plugin-auth'
import { chat, NOTE_KIND } from './contract.js'

// ONE server, THREE client↔server transports: WebSocket + HTTP share the http.Server; libp2p rides a
// started libp2p node. The browser's `?transport=` dial picks which wire to dial — and the accounts,
// channels, memberships and messages below are IDENTICAL on all three, because the plugins sit above
// the transport seam.
const PORT = Number(process.env.PORT ?? 8787) // WS + HTTP (one http.Server)
const P2P_PORT = Number(process.env.P2P_PORT ?? 9101) // libp2p /ws listener (browser dials this directly)
const NODE = process.env.NODE_NAME ?? 'node-1'
// the durable workspace lives next to this file: examples/react-chat-transports/chat.db (gitignored)
const DB_FILE = process.env.DB_FILE ?? fileURLToPath(new URL('../chat.db', import.meta.url))
// The ONLY thing this process shares with the verifier (src/verifier.ts) — no database, no super-line.
// A real deployment injects a real secret; this default keeps the example a one-command start.
const JWT_SECRET = process.env.AUTH_JWT_SECRET ?? 'dev-only-insecure-shared-secret'
// One switch, two backends. `PG_URL` is set under `docker compose` and unset on the README's local path,
// and it decides BOTH storage seams at once:
//
//   rows      (accounts · channels · messages)  Postgres + Electric  |  a sqlite file
//   documents (the per-channel prose)           Postgres op-log      |  in-memory
//
// They are separate seams by design — a CRDT document never joins a cross-collection batch — but there is
// no reason for them to land in different databases, so under compose they share one. Locally the rows
// still persist and the documents live only as long as the process, which is the honest trade for needing
// nothing installed. Nothing downstream can tell: each is just a `CollectionStore` / `CrdtCollectionStore`.
const PG_URL = process.env.PG_URL
const ELECTRIC_URL = process.env.ELECTRIC_URL ?? 'http://localhost:3000/v1/shape'

// A stable, seed-derived PeerId so the browser can dial a known multiaddr it fetches from /libp2p-addr.
const seed = new Uint8Array(32)
new TextEncoder().encodeInto(NODE.padEnd(8, '·'), seed)
const privateKey = await generateKeyPairFromSeed('Ed25519', seed)

const node = await createLibp2p({
  privateKey,
  addresses: { listen: [`/ip4/0.0.0.0/tcp/${P2P_PORT}/ws`] },
  transports: [webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: { identify: identify() },
})

const server = http.createServer()

// Tiny non-super-line endpoint: hand the browser the libp2p dial port + stable PeerId.
// Registered before createSuperLineServer adds its own 'request' listener; we only touch our path.
server.on('request', (req, res) => {
  if ((req.url ?? '').split('?')[0] !== '/libp2p-addr') return
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify({ port: P2P_PORT, peerId: node.peerId.toString() }))
})

/**
 * Exchange a SIGNED assertion for a SEALED one. Neither kind is client-mintable (ADR-0015) — both come
 * from the server; a sealed token additionally hides its payload from its own holder, which is what lets
 * you route a secret THROUGH a browser. So the browser proves who it is with the signed token it just
 * fetched, and back-office code decides what secret to seal into the reply.
 *
 * This is the realistic shape: the sealed `upstreamKey` stands in for a per-user credential to some
 * third-party API. The browser carries it to the server on the next connect and can never read it.
 */
server.on('request', (req, res) => {
  if ((req.url ?? '').split('?')[0] !== '/sealed-handoff') return
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify(body))
  }
  void (async () => {
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /i, '')
    const verified = bearer ? await authKit.tokens.verify(bearer) : null
    if (!verified) return json(401, { error: 'present a valid signed assertion to exchange' })
    const { token, expiresAt } = await authKit.tokens.mintSealed(verified.userId, {
      claims: { workspace: 'acme-demo' }, // public: vended to the browser as `env`
      sealed: { upstreamKey: `sk-live-${verified.userId.slice(0, 8)}` }, // encrypted: server-side only
    })
    json(200, { token, expiresAt })
  })().catch((err: unknown) => json(500, { error: err instanceof Error ? err.message : 'mint failed' }))
})

/**
 * Issue a SIGNED assertion for the caller. There is no client-facing mint anymore (ADR-0015) — a browser
 * can no longer sign its own token — so it presents the access token it already holds and the server mints
 * one for it. This authenticated, out-of-band route is the realistic shape of "the server vends you a token".
 */
server.on('request', (req, res) => {
  if ((req.url ?? '').split('?')[0] !== '/signed-token') return
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify(body))
  }
  void (async () => {
    const accessToken = (req.headers.authorization ?? '').replace(/^Bearer /i, '')
    // The server looks the access token up exactly as plugin-auth does internally: its stored primary key
    // is sha256(token) in `accessTokens` (never the raw token). No client mint is involved.
    const hash = createHash('sha256').update(accessToken).digest('hex')
    const row = accessToken
      ? ((await backend.read('accessTokens', hash)) as { userId: string; expiresAt: number } | undefined)
      : undefined
    if (!row || row.expiresAt < Date.now()) return json(401, { error: 'sign in first' })
    const { token, expiresAt } = await authKit.tokens.mintSigned(row.userId, { claims: { workspace: 'acme-demo' } })
    json(200, { jwt: token, expiresAt })
  })().catch((err: unknown) => json(500, { error: err instanceof Error ? err.message : 'mint failed' }))
})

// One CollectionStore shared by the server AND the auth kit (so authenticate reads sessions/users from it).
//
// Under `docker compose` this is Postgres, the same database the documents use — accounts, channels and
// messages in typed tables that Electric streams into this node's local replica. Keeping the rows in
// sqlite while the documents sat in Postgres would have been an arbitrary split, and a second durable
// store is a second thing to provision, back up and migrate.
//
// The README's no-Docker path has no Postgres, so it falls back to a sqlite file. Both are `CollectionStore`
// implementations, so nothing above this line — the auth kit, the chat kit, every policy — can tell.
const backend = PG_URL
  ? await pgliteCollections({ pgUrl: PG_URL, electricUrl: ELECTRIC_URL, collections: chat.collections })
  : sqliteCollections({ file: DB_FILE, collections: chat.collections })

// plugin-auth owns identity, access tokens, connection sessions, presence and the `guest` role;
// plugin-chat owns the whole chat model — its policies and its 20+ request handlers ship INSIDE
// chatKit.plugin. There are no hand-rolled rooms, join/send handlers or presence topics in this file.
// `jwt` enables server-side minting (`authKit.tokens.*`, used by /signed-token and /sealed-handoff) and `params: { jwt }` at connect.
// 2 minutes instead of the 15-minute default so the countdown — and an expired token's rejection — are
// reachable within one sitting. A JWT is only checked at connect, so a short TTL costs a demo nothing.
const authKit = auth({
  contract: chat,
  collections: backend,
  defaultRoles: ['user'],
  jwt: { secret: JWT_SECRET, ttlMs: 2 * 60_000 },
  // An assertion's payloads land on `ctx` (server-only). This one line vends the PUBLIC half as `env`
  // (ADR-0012), which is how the browser holding a SEALED token — which it cannot decode — learns what
  // is in it. `ctx.sealed` is deliberately absent here: `env` is what the client is allowed to see.
  resolveEnv: (ctx) => {
    const workspace = ctx.claims?.workspace
    return typeof workspace === 'string' ? { workspace } : undefined
  },
})
// A merged contract's `collections` is an intersection of every plugin's fragment, so it has no string
// index signature — the lookup a backend needs is by name at runtime. Widening it here is the whole fix.
const collectionDefs = chat.collections as Record<string, { crdt?: DocOptions } | undefined>
const crdtCollections = PG_URL
  ? await crdtPgliteCollections({ pgUrl: PG_URL, electricUrl: ELECTRIC_URL, docOptions: (n) => collectionDefs[n]?.crdt })
  : crdtMemoryCollections()

const chatKit = chatKitFactory({
  contract: chat,
  // A channel resource: a CRDT document attached to a channel, with the plugin owning its registry row,
  // its membership-gated access and its lifecycle. `owned` means the document is minted by the plugin and
  // cascade-deleted with its channel — right for a document that IS the channel's, and has no life without it.
  resources: { kinds: { [NOTE_KIND]: { collection: 'notes', lifecycle: 'owned', init: () => ({}) } } },
  hooks: {
    // one domain rule, applied to every writer: trim, and refuse empty bodies
    sendMessage: {
      before: (input) => {
        const content = typeof input.content === 'string' ? input.content.trim() : input.content
        if (!content) throw new Error('empty message')
        return { ...input, content }
      },
    },
    // Every channel gets exactly one document, by construction rather than on first visit — so the pane is
    // never empty-until-someone-clicks, and the registry row (which carries the title) exists from the start.
    createChannel: { after: (channel) => void attachNote(channel.id, channel.name).catch(() => {}) },
  },
})

/**
 * Idempotent: make sure this channel has its one document, and that the document actually exists.
 *
 * The two halves can come apart, which is the point of the second check. A resource row is a validated
 * sqlite row and survives a restart; the document it points at only survives if the CRDT backend is
 * durable. On the no-Postgres path it is not — so a restart leaves a registry row addressing a document
 * that is gone, and the pane would open onto NOT_FOUND. Re-minting the document under the id the row
 * already names keeps the pair consistent without inventing a second row.
 */
async function attachNote(channelId: string, name: string): Promise<void> {
  const existing = (await chatKit.resources.of(channelId)).find((r) => r.kind === NOTE_KIND)
  if (!existing) {
    await chatKit.resources.create({ channelId, kind: NOTE_KIND, title: `${name} notes` })
    return
  }
  if ((await srv.collection('notes').read(existing.docId)) === undefined) {
    await srv.collection('notes').create(existing.docId, {})
  }
}

const srv = createSuperLineServer(chat, {
  nodeKey: 'react-chat-transports', // stable across restarts: plugin-auth sweeps this node's stale sessions with it
  nodeName: NODE,
  transports: [
    webSocketServerTransport({ server }),
    httpServerTransport({ server }), // basePath defaults to /superline
    libp2pServerTransport({ node }), // protocol /super-line/1.0.0 on the started node
  ],
  collections: backend,
  crdtCollections,
  plugins: [authKit.plugin, chatKit.plugin, inspector()],
  authenticate: authKit.authenticate,
  identify: authKit.identify, // principal := userId, so plugin-chat's read policies key on the logged-in user
  onConnection: (_conn, ctx) => {
    const { userId } = ctx as AuthContext
    if (userId) void welcome(userId).catch((err) => console.error('connect setup failed', err))
  },
})

// ONE handler, and it is worth knowing why it is the only one. Every durable thing this app does —
// accounts, channels, membership, messages, the documents themselves — is answered by a plugin;
// implement() re-checks that coverage at runtime and throws on a key that is unhandled or handled twice,
// so this map is a live assertion about how little the app adds.
//
// What it adds is carets. Document *content* is a CRDT and needs nothing here: it rides the collection
// machinery, is policy-gated by the plugin, and converges on its own. But Yjs **awareness** — who is
// where, and what they have selected — is a separate protocol that never travels on a document update,
// and it is meant to evaporate. So it wants the opposite of a collection: an ephemeral broadcast that is
// never stored and never replayed. A room is exactly that.
//
// Sending is also what subscribes you. A client publishes its own caret the moment its editor mounts, so
// the first update doubles as the join and no second request is needed; moving to another channel moves
// the connection, which is what stops a long session accumulating rooms it stopped caring about.
const docRoom = (channelId: string): string => `doc:${channelId}`
const roomOf = new WeakMap<object, string>() // conn → the doc room it currently occupies

srv.implement({
  user: {
    awarenessUpdate: async ({ channelId, update }, _ctx, conn) => {
      // Membership is the gate, and it is the plugin's own answer — not a second, drifting copy of it.
      // Without this, a caret would reach a document its sender may not read.
      const mine = await chatKit.members.get(channelId, (conn.ctx as AuthContext).userId!)
      if (!mine) throw new Error('not a member')

      const room = docRoom(channelId)
      const previous = roomOf.get(conn)
      if (previous !== room) {
        if (previous) srv.room(previous).remove(conn)
        srv.room(room).add(conn)
        roomOf.set(conn, room)
      }
      // Everyone in the room INCLUDING the sender; the client drops its own echo by comparing the Yjs
      // client id it already carries, which is cheaper than the server tracking who not to send to.
      srv.room(room).broadcast('awareness', { channelId, update })
      return { ok: true }
    },
  },
})

/** Drop first-timers into the seeded public channels so nobody lands on an empty workspace. */
async function welcome(userId: string): Promise<void> {
  if ((await chatKit.members.channelsOf(userId)).length > 0) return
  for (const channel of await chatKit.channels.find()) {
    await chatKit.members.add(channel.id, userId).catch(() => {}) // idempotent-ish: ignore a racing dup
  }
}

/**
 * Seed the workspace once (the sqlite file survives restarts, so this is a no-op on later boots):
 * two public channels and two demo logins, so the README's "open two tabs on two wires" demo works
 * without a sign-up detour.
 */
async function seedWorkspace(): Promise<void> {
  const channels = new Set((await chatKit.channels.find()).map((c) => c.name))
  for (const name of ['general', 'random']) {
    if (!channels.has(name)) await chatKit.channels.create({ name })
  }
  // Backfill: `createChannel.after` covers every channel made from now on, but the seeded pair predates
  // it on an existing chat.db — and with the in-memory CRDT backend the documents are gone after a
  // restart while their registry rows are not, so re-attaching has to be idempotent rather than one-shot.
  for (const channel of await chatKit.channels.find()) await attachNote(channel.id, channel.name)

  const known = new Set((await authKit.users.find()).map((u) => u.displayName))
  for (const [displayName, email] of [
    ['Ada', 'ada@example.com'],
    ['Grace', 'grace@example.com'],
  ] as const) {
    if (known.has(displayName)) continue
    const user = await authKit.users.create({ displayName })
    await authKit.credentials.create(user.id, { email, password: 'superline' })
    await welcome(user.id)
  }
}

await seedWorkspace()

server.listen(PORT, () => {
  const { port } = (server.address() as AddressInfo) ?? { port: PORT }
  console.log(`[${NODE}] up on :${port} (WS + HTTP) · libp2p /ws :${P2P_PORT} · peer ${node.peerId.toString()}`)
  console.log(`  rows: ${PG_URL ? 'postgres (electric replica)' : DB_FILE}`)
  console.log(`  documents: ${PG_URL ? 'postgres op-log (electric replica)' : 'in-memory (set PG_URL to persist)'}`)
  console.log('  demo logins: ada@example.com / grace@example.com — password "superline"')
  console.log('  JWT: enabled (2-minute tokens) — run `pnpm verifier` for the stateless verifier service')
})
