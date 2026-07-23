import http from 'node:http'
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
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { httpServerTransport } from '@super-line/transport-http'
import { libp2pServerTransport } from '@super-line/transport-libp2p'
import type { AuthContext } from '@super-line/plugin-auth'
import { chat } from './contract.js'

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

// One CollectionStore shared by the server AND the auth kit (so authenticate reads sessions/users from it).
const backend = sqliteCollections({ file: DB_FILE, collections: chat.collections })

// plugin-auth owns identity, access tokens, connection sessions, presence and the `guest` role;
// plugin-chat owns the whole chat model — its policies and its 20+ request handlers ship INSIDE
// chatKit.plugin. There are no hand-rolled rooms, join/send handlers or presence topics in this file.
// `jwt` enables BOTH halves of the feature: the `getToken` request (mint) and `params: { jwt }` at connect.
// 2 minutes instead of the 15-minute default so the countdown — and an expired token's rejection — are
// reachable within one sitting. A JWT is only checked at connect, so a short TTL costs a demo nothing.
const authKit = auth({
  contract: chat,
  collections: backend,
  defaultRoles: ['user'],
  jwt: { secret: JWT_SECRET, ttlMs: 2 * 60_000 },
})
const chatKit = chatKitFactory({
  contract: chat,
  hooks: {
    // one domain rule, applied to every writer: trim, and refuse empty bodies
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
  nodeKey: 'react-chat-transports', // stable across restarts: plugin-auth sweeps this node's stale sessions with it
  nodeName: NODE,
  transports: [
    webSocketServerTransport({ server }),
    httpServerTransport({ server }), // basePath defaults to /superline
    libp2pServerTransport({ node }), // protocol /super-line/1.0.0 on the started node
  ],
  collections: backend,
  plugins: [authKit.plugin, chatKit.plugin, inspector()],
  authenticate: authKit.authenticate,
  identify: authKit.identify, // principal := userId, so plugin-chat's read policies key on the logged-in user
  onConnection: (_conn, ctx) => {
    const { userId } = ctx as AuthContext
    if (userId) void welcome(userId).catch((err) => console.error('connect setup failed', err))
  },
})

// Nothing to implement: every clientToServer key on this contract is answered by a plugin. The empty
// map is not a formality — implement() re-checks that coverage at runtime and throws if a key is
// unhandled (or handled twice), so this line is the assertion that the app added no surface of its own.
srv.implement({})

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
  console.log(`  collections: ${DB_FILE}`)
  console.log('  demo logins: ada@example.com / grace@example.com — password "superline"')
  console.log('  JWT: enabled (2-minute tokens) — run `pnpm verifier` for the stateless verifier service')
})
