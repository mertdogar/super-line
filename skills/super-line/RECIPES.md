# super-line — recipes & best practices

End-to-end patterns. All code uses the real, verified API. Start from the **Starter**, then layer the others in.

## Starter (copy-paste)

```ts
// contract.ts  — shared by server and client
import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const api = defineContract({
  roles: {
    user: {
      clientToServer: {
        send: { input: z.object({ room: z.string(), text: z.string() }), output: z.object({ id: z.string() }) },
      },
      serverToClient: {
        message: { payload: z.object({ room: z.string(), text: z.string(), from: z.string() }) }, // push event
        presence: { payload: z.object({ room: z.string(), count: z.number() }), subscribe: true }, // topic
      },
    },
  },
})
```

```ts
// server.ts
import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { api } from './contract.js'

const server = http.createServer()
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],  // WS transport; HTTP/SSE + libp2p transports also available
  authenticate: (h) => {
    const name = h.query.name                          // h: Handshake = { transport, headers, query, peer?, raw }
    if (!name) throw new Error('unauthorized')         // -> 401 at the upgrade
    return { role: 'user' as const, ctx: { name } }    // role + ctx; ctx.name in every user handler
  },
})

srv.implement({
  user: {
    send: async ({ room, text }, ctx, conn) => {
      conn.emit('message', { room, text, from: ctx.name }) // or srv.room(room).broadcast(...)
      return { id: crypto.randomUUID() }
    },
  },
})

server.listen(3000)
```

```ts
// client.ts
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { api } from './contract.js'

const client = createSuperLineClient(api, { transport: webSocketClientTransport({ url: 'ws://localhost:3000' }), role: 'user', params: { name: 'ada' } })
client.on('message', (m) => console.log(`${m.from}: ${m.text}`))
await client.send({ room: 'lobby', text: 'hi' })
```

## Multiple roles (user + agent)

A `user` and an `agent` connect to the same server with different surfaces. A `shared` block is common to both; role enforcement is automatic (a cross-role call gets `NOT_FOUND`).

```ts
export const api = defineContract({
  shared: {
    clientToServer: { join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) } },
    serverToClient: { message: { payload: z.object({ room: z.string(), text: z.string(), from: z.string() }) } },
  },
  roles: {
    user:  { clientToServer: { say:      { input: z.object({ room: z.string(), text: z.string() }), output: z.object({ id: z.string() }) } } },
    agent: { clientToServer: { announce: { input: z.object({ room: z.string(), text: z.string() }), output: z.object({ id: z.string() }) } } },
  },
})

srv.implement({
  shared: { join: async ({ room }, _ctx, conn) => { srv.room(room).add(conn); return { ok: true } } },
  user:  { say:      async ({ room, text }, ctx) => { srv.room(room).broadcast('message', { room, text, from: ctx.name }); return { id: nano() } } },
  agent: { announce: async ({ room, text }, ctx) => { srv.room(room).broadcast('message', { room, text, from: `🤖 ${ctx.name}` }); return { id: nano() } } },
})

const user  = createSuperLineClient(api, { transport: webSocketClientTransport({ url }), role: 'user',  params: { name: 'ada' } })
const agent = createSuperLineClient(api, { transport: webSocketClientTransport({ url }), role: 'agent', params: { name: 'helper' } })
await user.say({ room: 'lobby', text: 'hi' })          // ✓
await agent.announce({ room: 'lobby', text: 'on it' }) // ✓
// user.announce(...) is a COMPILE error (not on the user surface); forced at runtime -> NOT_FOUND
```

In a `user` handler, `ctx` is the user's ctx; in `agent`, the agent's. In a `shared` handler, `ctx` is the union (use common fields, or branch on `conn.role`).

## Auth at the upgrade (token → { role, ctx })

The client's `role` option is a **claim** sent as a query param; resolve the real role from the credential and verify the claim.

```ts
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate: async (h) => {
    const user = await verifyJwt(h.query.token)                 // throw to reject with 401 (no socket opened)
    if (user.role !== h.query.role) throw new SuperLineError('FORBIDDEN', 'role not granted')
    return user.role === 'admin'
      ? { role: 'admin' as const, ctx: { user } }
      : { role: 'user' as const, ctx: { user } }
  },
})
// client: createSuperLineClient(api, { transport: webSocketClientTransport({ url }), role: 'admin', params: { token } })
```

## Authorize topic subscriptions (private streams)

```ts
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })], authenticate,
  authorizeSubscribe: async (topic, ctx) => {
    if (topic.startsWith('org:')) return ctx.user.orgs.includes(topic.slice(4))
    return true                                // return false or throw -> client's sub.ready rejects FORBIDDEN
  },
})
```

## Middleware (rate-limit, metrics, per-message authz)

```ts
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })], authenticate,
  use: [
    async (ctx, info, next) => { rateLimit(info.conn.role, info.name); await next() },   // throw to reject
    async (_ctx, info, next) => { const t = Date.now(); await next(); metric(info.name, Date.now() - t) },
  ],
})
// info = { kind: 'request' | 'subscribe', name, conn }; call next() to proceed.
```

## Rooms: join + broadcast (the canonical pattern)

Rooms are **mixed-role**; `broadcast` delivers a **shared** event. Put room-broadcast events in `shared.serverToClient`.

```ts
srv.implement({
  shared: {
    join: async ({ room }, _ctx, conn) => { srv.room(room).add(conn); return { ok: true } },  // server-controlled membership
  },
  user: {
    send: async ({ room, text }, ctx) => {
      srv.room(room).broadcast('message', { room, text, from: ctx.user.id })  // -> client.on('message')
      return { id: nano() }
    },
  },
})
// client: await client.join({ room }); client.on('message', render)
// On reconnect the client must re-run join() (rooms are server-controlled, not auto-restored).
```

## Direct message to a user — cross-node safe

Don't stash a `conn` to DM someone (it's node-local). With an `identify` hook set, target the user directly — `toUser` reaches every device on any node:

```ts
createSuperLineServer(api, { transports: [webSocketServerTransport({ server })], authenticate, identify: (conn) => conn.ctx.user.id })
// later, from anywhere (any node):
srv.toUser(targetId).emit('dm', { from, text })   // 'dm' is a shared event; all the user's devices
srv.toConn(connId).emit('dm', { from, text })     // or one specific connection
```

## Introspection & presence dashboard

```ts
createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })], authenticate,
  identify: (conn) => conn.ctx.user.id,
  describeConn: (conn) => ({ plan: conn.ctx.user.plan }),
})

// node-local (sync): cheap reads of THIS process
srv.local.connections.length
srv.local.connections.filter((c) => c.role === 'agent')

// cluster-wide (async): reads the presence registry (in-memory or Redis)
await srv.cluster.count()                       // total everywhere
await srv.cluster.topology()                    // [{ nodeId, connections, rooms, alive }]
await srv.cluster.room('lobby')                 // members across nodes
await srv.isOnline(userId)                       // show an online dot
```

## Ask a client a question (server → client request)

```ts
// contract: shared.serverToClient.confirm = { input: z.object({ q: z.string() }), output: z.object({ ok: z.boolean() }) }

// client answers (throw SuperLineError for a typed failure):
client.implement({ confirm: async ({ q }) => ({ ok: await askUser(q) }) })

// server asks a specific connection (cross-node), awaits the typed reply:
const { ok } = await srv.toConn(connId).request('confirm', { q: 'Deploy now?' }, { timeout: 10_000 })
// to ask a USER, pick a connection first (request is single-target):
const [c] = await srv.cluster.byUser(userId)
if (c) await srv.toConn(c.id).request('confirm', { q: '…' })
```

## Per-connection state (typed)

```ts
// contract: roles.user.data = z.object({ lastSeenMsgId: z.number() })
srv.implement({
  user: {
    ack: async ({ id }, _ctx, conn) => {
      conn.data.lastSeenMsgId = id   // typed, mutable, per-connection
      return {}
    },
  },
})
// seed data (and have it land in the cluster descriptor) from onConnection:
onConnection: (conn) => { conn.data.lastSeenMsgId = 0 }
```

## Show the signed-in user's entitlements live (`env`)

`env` is the client-visible sibling of `conn.data` — typed, per-connection, mutable, but PUSHED to the client and never persisted. Use it to hand a connection working credentials/config; the client's OWN code wires them into outbound calls, never an LLM.

```ts
// contract: roles.user.env = z.object({ plan: z.enum(['free', 'pro']), apiKey: z.string() })

// seed the INITIAL value from authenticate (env is optional; omit/undefined = none)
authenticate: async (h) => {
  const user = await lookupUser(h.query.uid)
  return { role: 'user' as const, ctx: { uid: user.id }, env: { plan: user.plan, apiKey: user.apiKey } }
}

// update it LIVE later (plan change, key rotation) — node-local or cross-node, any of the user's devices
conn.setEnv({ plan: 'pro', apiKey })                    // this connection only
srv.toUser(userId).setEnv({ plan: 'pro', apiKey })       // every device, any node
```

```ts
// client — a reactive handle; wire it into your own code, never expose it to an LLM
await client.env.ready
const { plan, apiKey } = client.env.current!
client.env.subscribe((env) => reconfigureBilling(env.plan))

// React
const env = useEnv()   // EnvOf<C,R> | null — null until the first push / for a role with no env
```

- Masked by default in the Control Center (`•••` per key, shape still shown) — allow-list safe keys with `inspector({ revealEnvKeys: ['plan'] })`.
- `@super-line/plugin-auth`: `auth({ resolveEnv: (ctx) => ({ plan, apiKey }) })` seeds it at connect from the resolved identity; `authKit.pushEnv(userId, env)` updates it later.

## Presence via a topic

```ts
// roles.user.serverToClient.presence: { payload: { room, count }, subscribe: true }
const counts = new Map<string, number>()
const bump = (room: string, d: number) => { const n = Math.max(0, (counts.get(room) ?? 0) + d); counts.set(room, n); return n }

srv.implement({
  user: {
    join: async ({ room }, _ctx, conn) => {
      srv.room(room).add(conn)
      srv.forRole('user').publish('presence', { room, count: bump(room, +1) })   // role topic, server-only
      return { ok: true }
    },
  },
})
// onDisconnect: (conn) => { /* look up the conn's room, forRole('user').publish('presence', bump(room, -1)) */ }
// client: const sub = client.subscribe('presence', p => setOnline(p.count)); await sub.ready
```

## Client → others (clients can't publish)

```ts
// ❌ clients cannot publish to topics
// ✅ send a request; the server validates/authorizes, then fans out
srv.implement({
  user: {
    setPrice: async ({ symbol, price }, ctx) => {
      if (!ctx.user.canTrade) throw new SuperLineError('FORBIDDEN')
      srv.forRole('user').publish('prices', { symbol, price })   // role topic
      return { ok: true }
    },
  },
})
```

## Cluster event bus (cluster coordination)

A bus channel is just a **shared topic**. One `server.publish` fans out to three kinds of subscriber at once: same-node `server.subscribe` listeners (local echo, in-process, no Redis/WS hop), other nodes' `server.subscribe` listeners (over the adapter, inbound-validated), and subscribed clients. `server.subscribe` fires for a publish from **any** node including this one — self-exclude with `if (from === srv.nodeId) return`.

```ts
export const api = defineContract({
  shared: { serverToClient: { rebalance: { payload: z.object({ shard: z.number() }), subscribe: true } } },
  roles: { user: {…} },
})

const off = srv.subscribe('rebalance', ({ shard }, { from }) => {
  if (from === srv.nodeId) return        // ignore our own publish (local echo)
  moveShard(shard)
})                                       // returns an unsubscribe fn
srv.publish('rebalance', { shard: 3 })   // -> this node's listeners + every other node + subscribed clients
```

The bus is **opt-in** pub/sub on a shared topic. It's a different tool from server-CHOSEN **events** (`conn.emit` / `room.broadcast` / `toConn(id).emit` / `toUser(id).emit`), which have no client opt-in and no server-side subscribe.

## Multi-node (Redis) — same code, scaled

```ts
import { createRedisAdapter } from '@super-line/adapter-redis'
const srv = createSuperLineServer(api, { transports: [webSocketServerTransport({ server })], authenticate, adapter: createRedisAdapter('redis://localhost:6379') })
// every server process gets an adapter pointing at the same Redis; rooms, topics, AND the cluster event bus fan out across nodes.
```

## Other adapters (libp2p · RabbitMQ · ZeroMQ)

The `adapter:` slot is pluggable — same code, different fan-out infra. All factories are **async** (the connection/node is set up before the server starts). All ship a cluster presence directory by default (`presence: false` to disable). One-line swaps for the Redis line above:

```ts
// decentralized, broker-less — one shared gossipsub topic; bring your own node, or let it build one
// discovery: 'mdns' (LAN/docker, zero-config) | { bootstrap: [multiaddr] } | { relay: multiaddr } (NAT; run createRelayNode)
import { createLibp2pAdapter } from '@super-line/adapter-libp2p'      // npm i @super-line/adapter-libp2p
const adapter = await createLibp2pAdapter({ discovery: 'mdns' })

// broker-routed — channels become routing keys on one durable direct exchange
import { createRabbitmqAdapter } from '@super-line/adapter-rabbitmq'  // npm i @super-line/adapter-rabbitmq
const adapter = await createRabbitmqAdapter('amqp://localhost:5672')

// brokerless full-mesh — this node binds a PUB, connects a SUB to each peer's PUB
import { createZeroMqAdapter } from '@super-line/adapter-zeromq'      // npm i @super-line/adapter-zeromq
const adapter = await createZeroMqAdapter({ bind: 'tcp://0.0.0.0:5555', peers: ['tcp://10.0.0.2:5555'] })
// (ZeroMQ also has mode:'proxy' for a central XSUB/XPUB forwarder — see createZeroMqProxy)

const srv = createSuperLineServer(api, { transports: [webSocketServerTransport({ server })], authenticate, adapter })
```

## Swap the client↔server transport (HTTP/SSE · libp2p · loopback)

The WS default is just one `transports:`/`transport:` pairing — the server can mount several at once. `authenticate` gets a normalized `Handshake` regardless of transport (`h.transport` tells you which). Match the client transport to a server transport.

```ts
// HTTP — SSE (or long-poll) downstream + POST upstream; compose on the SAME http.Server as WS
import { httpServerTransport } from '@super-line/transport-http'   // npm i @super-line/transport-http
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server }), httpServerTransport({ server })], // both, side by side
  authenticate,
})

import { httpClientTransport } from '@super-line/transport-http'
// Node has no global EventSource: pass one for SSE, or use mode:'longpoll' (fetch-only, works everywhere)
import { EventSource } from 'eventsource'
const client = createSuperLineClient(api, { transport: httpClientTransport({ url: 'http://localhost:3000', EventSource }), role: 'user' })
// browser: httpClientTransport({ url }) — global EventSource is already present
```

```ts
// libp2p — bring your own started node on both ends; the server handles a protocol stream per connection
import { libp2pServerTransport } from '@super-line/transport-libp2p'  // npm i @super-line/transport-libp2p
const srv = createSuperLineServer(api, { transports: [libp2pServerTransport({ node: serverNode })], authenticate })

import { libp2pClientTransport } from '@super-line/transport-libp2p'
const client = createSuperLineClient(api, {
  transport: libp2pClientTransport({ node: clientNode, multiaddr: serverNode.getMultiaddrs() }),
  role: 'user',
})
```

```ts
// loopback — in-memory, no socket; both ends in one process (tests, or proving the transport isn't WS-shaped)
import { createLoopbackTransport } from '@super-line/transport-loopback'  // npm i @super-line/transport-loopback
const loopback = createLoopbackTransport()
const srv = createSuperLineServer(api, { transports: [loopback.server], authenticate })
const client = createSuperLineClient(api, { transport: loopback.client(), role: 'user' })
```

## Collections (typed rows)

A **collection** is server-authoritative, on-contract persisted state — typed **rows**, schema-validated, with deny-by-default row security. super-line syncs the rows; **TanStack DB** is the query engine (joins, live queries). Declare rows on the contract, pick one backend, write `policies`.

```ts
// contract.ts — a top-level `collections` block; rows flow end-to-end as RowOf<C, 'messages'>
export const api = defineContract({
  collections: {
    users:    { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' },
    messages: { schema: z.object({ id: z.string(), channelId: z.string(), authorId: z.string(), text: z.string(), createdAt: z.number() }),
                key: 'id', references: { authorId: 'users' } },   // advisory FK (opt-in checkReferences)
  },
  roles: { user: { clientToServer: {} } },
})
```

```ts
// server.ts — ONE backend for ALL row collections + deny-by-default policies
import { memoryCollections } from '@super-line/collections-memory'  // or sqliteCollections({ file, collections }) · await pgliteCollections({ pgUrl, collections })
import { isIn, eq } from '@super-line/core'
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid, channels: ['general'] } }),
  identify: (conn) => conn.ctx.uid,
  collections: memoryCollections(),
  policies: {
    messages: {
      read:  (principal, ctx) => isIn('channelId', ctx.channels),  // → an IR filter ANDed into every snapshot + live change (undefined = whole collection)
      write: (principal, op, next, prev) => op === 'delete' ? prev?.authorId === principal : next?.authorId === principal,
    },
    users: { read: () => undefined },                              // everyone reads all users; writes stay server-only (write omitted)
  },
})
await srv.collection('messages').insert({ id: nano(), channelId: 'general', authorId: 'system', text: 'welcome', createdAt: Date.now() }) // co-write: policy-free, still schema-validated
```

```ts
// client.ts — a live, ordered, filtered row-set
const sub = client.collection('messages').subscribe({ filter: eq('channelId', 'general'), orderBy: [{ field: 'createdAt', dir: 'asc' }], limit: 50 })
await sub.ready                                    // AWAIT before depending on live delivery (frames process concurrently)
sub.subscribe((ev) => render(sub.rows()))         // ev: { type: 'insert'|'update'|'delete', id, row } — NON-optimistic (optimism is TanStack's job)
await client.collection('messages').insert({ id: nano(), channelId: 'general', authorId: uid, text: 'hi', createdAt: Date.now() })
// React: const { rows, insert, update, delete: del } = useCollection('messages', { filter: eq('channelId', id) })
```

```ts
// joins + live queries — TanStack DB is the query engine
import { createCollection, createLiveQueryCollection, eq as teq } from '@tanstack/db'
import { superLineCollectionOptions } from '@super-line/tanstack-db'
const messages = createCollection(superLineCollectionOptions(client, api, 'messages', { query: { filter: eq('channelId', 'general') } }))
const users    = createCollection(superLineCollectionOptions(client, api, 'users'))
const enriched = createLiveQueryCollection((q) =>
  q.from({ m: messages }).join({ u: users }, ({ m, u }) => teq(u.id, m.authorId), 'inner')
   .select(({ m, u }) => ({ id: m.id, text: m.text, author: u.name })))
```

- **Deny-by-default.** Omit a collection's `read`/`write` and that op is server-only. `read` returns an IR filter (ANDed into snapshots + live routing); `write` returns a bool.
- **One backend, atomic batches.** All row collections share one `collections:` backend (one transaction domain), so a cross-collection `batch([...])` is atomic.
- **Backends:** `collections-memory` (relay) · `collections-sqlite` (durable · relay, IR→SQL pushdown) · `collections-pglite` (**self**: central Postgres + Electric→PGlite, no adapter). Runnable: `examples/collections` · `examples/collections-chat`.

## First-party auth (`@super-line/plugin-auth`)

Real login without hand-rolling sessions: email/password, server-issued sessions, data-driven roles, API keys, JWT. It's a **paired plugin** — a contract fragment + a server plugin + a client — and stores all identity in collections, so it needs a collection backend. Three touch-points.

```ts
// 1 · contract.ts — merge the auth fragment (adds the `guest` role + identity collections). Do NOT declare `guest` yourself.
import { authContract } from '@super-line/plugin-auth'
export const app = defineContract({
  roles: { user: {}, admin: {} },
  collections: { messages: { schema: messageSchema, key: 'id', references: { authorId: 'users' } } }, // your rows can FK the auth `users`
  plugins: [authContract()],
})
```

```ts
// 2 · server.ts — build the kit over the SAME collection backend, then wire 4 fields
import { auth } from '@super-line/plugin-auth/server'
import { sqliteCollections } from '@super-line/collections-sqlite'
const backend = sqliteCollections({ file: 'app.db', collections: app.collections })
const authKit = auth({
  contract: app,
  collections: backend,
  defaultRoles: ['user'],
  jwt: { secret: process.env.JWT_SECRET! },   // opt-in: enables authKit.tokens.* + params:{ jwt } connect
  rejectUnauthenticated: true,                // a PRESENTED-but-invalid credential throws UNAUTHORIZED instead of
})                                            // silently becoming a guest (see the notes below — this is the sharp edge)
const srv = createSuperLineServer(app, {
  transports: [webSocketServerTransport({ server })],
  nodeKey: 'app-replica-1',             // REQUIRED by plugin-auth: a STABLE per-replica name that survives restarts
                                        // (it keys per-node session reconciliation). Omit it and the plugin throws at boot.
  collections: backend,                 // SAME instance passed to auth()
  authenticate: authKit.authenticate,   // resolves guest / access token / API key / bearer assertion
  identify: authKit.identify,           // principal = userId
  plugins: [authKit.plugin],            // the runtime half: auth handlers + identity-collection policies
})
// later, from anywhere: await authKit.revoke(userId)   // revoke tokens + end sessions + kick every device cluster-wide
```

```ts
// 3 · client — authClient owns the guest↔authed reconnect (role is frozen at connect, so login is a reconnect)
import { authClient } from '@super-line/plugin-auth/client'
const a = authClient({
  authedRole: 'user',
  connect: ({ role, params }) =>
    createSuperLineClient(app, { transport: webSocketClientTransport({ url }), role: role as 'user', params }),
})
await a.ready                                  // confirms any persisted token (localStorage 'superline.auth.token')
if (a.state.status === 'guest') await a.signIn({ email, password })   // or a.signUp({ email, password, displayName })
a.client.collection('messages').subscribe(/* … */)                   // a.client is the live (authed) client
await a.signOut()
```

```tsx
// React — createAuth wraps the same client
import { createAuth } from '@super-line/plugin-auth/react'
export const { AuthProvider, useAuth } = createAuth({ authedRole: 'user', connect })
function Gate() {
  const { ready, state, signIn, signOut } = useAuth()
  if (!ready) return <Spinner />
  if (state.error) return <ReconnectBanner reason={state.error.reason} />   // a PRESENTED token was rejected
  return state.status === 'authed' ? <App onSignOut={signOut} /> : <Login onSubmit={signIn} />
}
```

- **A stable `nodeKey` is required** and the **same `CollectionStore`** goes to both `auth({ collections })` and `createSuperLineServer({ collections })` — `authenticate` reads sessions/users off it directly.
- **A bad credential degrades to `guest` by default.** The connection is *accepted* as a guest, so a client built for `user` never sees a connect error — it just `NOT_FOUND`s on every call. Either confirm with `whoami()` (what `authClient` does) or set `rejectUnauthenticated: true` as above. A credential-*less* connect still resolves guest either way.
- `jwt` is opt-in: without it there are no bearer assertions and only access tokens / API keys connect. Assertions are **server-minted only** (`authKit.tokens.mintSigned` / `mintSealed`) — there is no client-facing mint. An API key (`slp_…`) carries one fixed role and is revocable; an assertion is stateless and unrevocable until it expires (`authKit.users.deactivate(id)` is the escape hatch — connect performs one user read). Every accepted authenticated connection still creates a durable session row, aggregated into the client-readable `userPresence` collection.
- **Online dots come from `userPresence`**, not the deny-all `sessions` rows: `client.collection('userPresence').subscribe({ filter: isIn('userId', ids) })` → `{ userId, connectedAt, lastSeenAt }` (`null` when offline).
- `sendPasswordReset` is a host callback; without it `requestPasswordReset` is a silent no-op (never leaks whether an email exists). Runnable: `examples/auth` (CLI) · `examples/collections-chat` (real login).

## Route a secret *through* an untrusted client (sealed assertions)

The headline use of a **sealed** assertion (a JWE): the server mints a token whose payload the browser holding it **cannot read**, the browser connects with it, and handlers read the decrypted payload off `ctx.sealed`. That closes the loop — the client handed you a key it never had access to. A **signed** assertion (a JWS) is the same handshake with a *public* payload: reach for it when a service with none of your infrastructure must verify identity offline.

```ts
// 1 · SERVER — mint inside an ALREADY-AUTHENTICATED route/RPC. There is no `req.user` in super-line and no
//     client-side mint: the caller proves who they are first, then you mint for that subject.
const { token } = await authKit.tokens.mintSealed(userId, {
  claims: { workspace: 'acme' },            // PUBLIC half — safe to show the user
  sealed: { upstreamKey: 'sk-live-…' },     // ENCRYPTED — the browser holding this cannot read it
})
// signed sibling, for a third party that verifies offline with `jose` and no database:
const { token: signed } = await authKit.tokens.mintSigned(userId, { claims: { workspace: 'acme' } })
```

```ts
// 2 · CLIENT — connect with it under `jwt` (authMethod becomes 'jwt-sealed'). For an app that is ONLY ever
//     sealed (no password, no guest UI), let createAuth own the lifecycle instead of building a client by hand:
const { AuthProvider, useAuth } = createAuth<typeof app, 'user'>({
  authedRole: 'user',
  tokenParam: 'jwt',                                          // → params:{ jwt }
  resolveToken: async () => ({ token: await fetchSealedToken() }),  // your mint route; return null to stay guest
  connect: ({ role, params }) => createSuperLineClient(app, { transport, role: role as 'user', params }),
})
// createAuth boots as `guest`, awaits the first resolveToken() before `ready` resolves, then swaps to `user` —
// so downstream code is just `await auth.ready; auth.client`, with no hand-rolled "not ready yet" deferred.
// resolveToken's token is NEVER persisted (the source owns re-acquisition).
```

```ts
// 3 · SERVER — both bags are on the connection context; the handler returns only what it chooses to
srv.implement({
  user: {
    useUpstream: async (_input, ctx) => {
      const key = ctx.sealed?.upstreamKey as string | undefined   // decrypted server-side; opaque to its holder
      const workspace = ctx.claims?.workspace as string | undefined
      return { workspace: workspace ?? null, tail: key ? `…${key.slice(-4)}` : null }
    },
  },
})
```

- **Roles come from different places.** A signed assertion carries roles in its own claims; a sealed one does not — connect reads them from the user row, so a grant made after minting is live on the very next connection and the mint site cannot escalate anyone.
- **Verification uses the algorithms YOU configured** — the token's header never selects a key, which closes the alg-confusion attack. Go asymmetric with `jwt: { signed: { alg: 'EdDSA', key: jwk } }`; validate the bags with `claims`/`sealedClaims` schemas.
- **Keep `ttlMs` short** (default 15 min). An assertion is in no table, so `authKit.revoke()` cannot touch it.
- Show the public half to the client with `auth({ resolveEnv: (ctx) => ctx.claims })` — it arrives as `client.env`. The sealed half never leaves the server.
- **Don't confuse the two credential families:** an **access token** (`params: { token }`) is a long-lived (~30-day) reusable lookup key — whoever validates it needs your database. A **bearer assertion** (`params: { jwt }`) is short-lived and self-proving.

## Extend auth with server-side hooks (audit, provisioning policy, enrichment)

`hooks` wrap plugin-auth's **server-invoked** operations — `authenticate` plus the imperative kit. (The client request handlers `signIn`/`signUp`/… are deliberately not hookable: they already have a veto seam in `use:` middleware.) A `before` **transforms or vetoes**; an `after` observes. ⚠️ Payloads carry raw secrets — never log one wholesale.

```ts
const authKit = auth({
  contract: app,
  collections: backend,
  hooks: {
    authenticate: {
      // `after` may TRANSFORM the resolved identity — enrich ctx, override env, even change the role.
      // Fires for EVERY resolution, guests included.
      after: (result, handshake) => {
        audit('connect', { role: result.role, userId: result.ctx.userId, method: result.ctx.authMethod })
        if (result.ctx.userId && bannedIps.has(handshake.headers['x-real-ip'] ?? '')) throw new SuperLineError('FORBIDDEN')
        return { ...result, ctx: { ...result.ctx, tenant: tenantOf(result.ctx.userId) } }
      },
    },
    users: {
      create: {
        before: (input) => ({ ...input, displayName: input.displayName.trim() }),   // transform
        after: (user) => provisionWorkspace(user.id),                                // observe (a throw propagates)
      },
    },
    apiKeys: {
      // ⚠️ `after` receives the RAW slp_… key — this is the one place to deliver it out-of-band, never to log it
      create: { after: ({ id, role, label }) => audit('apikey.mint', { id, role, label }) },
    },
  },
  onHookError: (error, op) => logger.error({ error, op }),   // sink for a swallowed non-vetoable throw
})
```

- **`before` throws veto** the operation — except `users.deactivate.before`, which cannot veto (a throw routes to `onHookError` and the deactivation proceeds; a ban must not be blockable by a broken hook).
- **`after` throws propagate**, but the write already happened — treat it as "the op succeeded, the follow-up failed".
- Hook keys mirror the `authKit` surface exactly: `authenticate` · `users.{create,update,setRoles,deactivate,reactivate}` · `credentials.{create,setPassword}` · `apiKeys.{create,revoke}` · `tokens.{mintSigned,mintSealed}`.

## Debug what super-line is doing (structured logs)

super-line logs internally through LogTape under `['super-line', '<pkg>', '<subsystem>']`. There is **no per-instance `logger:` option** — logging is configured once for the process.

```ts
import { enableSuperLineLogging } from '@super-line/core'
enableSuperLineLogging({ level: 'debug' })   // pretty, SECRET-REDACTING console. Call it before creating the server.
// → super-line.server.conn / .dispatch, super-line.plugin-auth.authn ("degraded to guest: api key invalid or expired"),
//   .session, adapter mesh diagnostics — the fastest way to answer "why did this connection resolve as a guest?"
```

```ts
// An app that runs its OWN LogTape configure() must NOT also call enableSuperLineLogging (one process-global
// config; the later call replaces the earlier). Add a super-line logger to your own config instead:
import { configure, getConsoleSink } from '@logtape/logtape'
import { redactByField } from '@logtape/redaction'
import { LOG_ROOT, SUPER_LINE_REDACT_FIELDS } from '@super-line/core'
await configure({
  sinks: { console: redactByField(getConsoleSink(), SUPER_LINE_REDACT_FIELDS) },   // keep the redaction
  loggers: [{ category: [LOG_ROOT], lowestLevel: 'info', sinks: ['console'] }, /* your own */],
})
```

- Redaction is **on by default** and covers password/token/jwt/apiKey/secret/credential/email-ish field names at any depth, plus JWT patterns in formatted text. `redact: false` only for trusted local runs.
- Filter narrower than the root when one subsystem is noisy: `['super-line', 'plugin-auth']`.

## Chat (`@super-line/plugin-chat`)

Channels + membership + messages as a paired plugin (requires `plugin-auth`). Bots are **regular users**; the reply is a **streamed message**.

### Provision a bot + run its loop

```ts
import { chat as chatKitFactory, provisionChatBot } from '@super-line/plugin-chat/server'
import { chatClient, onChatMessage } from '@super-line/plugin-chat/client'

const chatKit = chatKitFactory({ contract })                 // + plugins: [authKit.plugin, chatKit.plugin] on the server
const room = await chatKit.channels.create({ name: 'ask-ai', visibility: 'public' })

// restart-idempotent identity + API key, joined to its channels
const { user, apiKey } = await provisionChatBot(authKit, chatKit, { name: 'Ask AI', channels: [room.id] })
const bot = chatClient(
  createSuperLineClient(contract, { transport: webSocketClientTransport({ url }), role: 'user', params: { apiKey } }),
  { userId: user.id },
)
await bot.ready

onChatMessage(bot, async ({ channelId, history }) => {       // turns serialized per channel; own/backlog skipped
  const w = await bot.stream(channelId)
  try {
    w.push({ type: 'part_start', key: 't', partType: 'text' })
    w.push({ type: 'delta', key: 't', text: 'thinking…' })
    w.push({ type: 'part_end', key: 't' })
    await w.finalize()
  } finally { await w.abort().catch(() => {}) }              // settle in a finally — never leak a streaming message
}, { channels: [room.id] })
```

### Stream a Mastra supervisor + subagents into one message

```ts
import { mastraEngine } from '@super-line/plugin-chat/mastra'
const engine = mastraEngine({ agent: supervisor, subagents: [{ agent: worker }] })   // plain Mastra Agents; delegate tool injected
onChatMessage(bot, ({ channelId, history }) => engine.respond(bot, channelId, history))
// each delegation nests under its delegate part (parent lanes); reasoning streams if the Agent enables thinking via defaultOptions
```

### Per-channel bot memory (root agent only)

```ts
// Agents arrive FULLY CONFIGURED — the engine never proxies Mastra config. Memory = the root
// Agent's own defaultOptions, a function of the requestContext the engine forwards per turn:
import { RequestContext } from '@mastra/core/request-context'

const supervisor = new Agent({
  /* … */ memory,                                            // a Mastra Memory instance
  defaultOptions: ({ requestContext }) => ({
    memory: { thread: String(requestContext?.get('channelId')), resource: 'bot' },
  }),
})
onChatMessage(bot, ({ channelId, history }) => {
  const rc = new RequestContext(); rc.set('channelId', channelId)
  return engine.respond(bot, channelId, history.slice(-1), { requestContext: rc })
})
// workers stay stateless BY CONSTRUCTION (their Agents don't derive memory); pass ONLY the new
// turn as input — Mastra saves stream input to the thread + recalls the past; full history doubles both
```

### Agent co-edits a channel resource (canvas/doc) — the headline

```ts
// 1) declare YOUR CRDT doc collection + register it as a kind (create + policies + cascade, one act)
const contract = defineContract({
  collections: { canvases: { schema: canvasSchema, crdt: { mode: 'document' } } },
  roles: { user: {}, guest: {} }, plugins: [authContract(), chatContract()],
})
const chatKit = chatKitFactory({ contract, resources: { kinds: { canvas: { collection: 'canvases', init: () => ({ title: 'Canvas', notes: {} }) } } } })
// server needs crdtCollections: crdtMemoryCollections(); client needs crdtCollections: crdtCollectionsClient()

// 2) human edits via the NATIVE doc handle
const canvas = await human.createResource(channelId, { kind: 'canvas', title: 'Board' })
const doc = humanRaw.collection('canvases').open(canvas.docId); await doc.ready
doc.update({ notes: { n1: { x: 40, y: 40, color: '#fef08a', text: 'kickoff' } } })

// 3) agent edits the SAME doc via the acked, membership-gated write_resource path
const { snapshot } = await bot.writeResource(channelId, 'canvas', canvas.docId, [
  { path: ['notes', 'n2'], set: { x: 240, y: 40, color: '#bfdbfe', text: 'ship it' } },  // object-key paths only; ≤64 ops
])                                                                                        // acked → snapshot, or throws VALIDATION
```

- **Two co-writer doors:** `writeResource` (agent as a channel MEMBER — membership+registry gated, best-effort validated, honest `VALIDATION`) vs `srv.collection(n).open(id)` (trusted, unvalidated, in-process). Use `writeResource` for an agent inside the channel.
- Paths address **object keys only** — set a whole array at its key, never index into one (CRDT arrays are opaque leaves → `VALIDATION`).
- For the LLM, `chatAgentTools(botRawClient, { resourceShapes: { canvas: '{ … }' } })` adds `list/read/create/detach/write_resource`; pass shapes so it writes without reading first.
- Presence: `useResourcePresence(row)` (React) announces open/heartbeat/close; reap with `chatKit.resources.sweepPresence({ olderThanMs })`.
- Runnable: `examples/chat-supervisor` (human + agent co-edit a canvas, full UI) · `examples/chat-resources` (headless mechanics). Guide: `/how-to/chat-resources`; Tutorial 6.

## Author a plugin · compose a library

Two ways to ship reusable super-line surface: a **contract plugin** (merged into a host's contract, like auth) or a **composed surface** (spliced into one role). Both keep types end-to-end.

```ts
// A CONTRACT PLUGIN — a fragment (collections + roles + shared) authored with the helper (never a plain const)
import { defineContractPlugin } from '@super-line/core'
export function chatPlugin() {
  return defineContractPlugin('chat', {
    collections: { chatMessages: { schema: msgSchema, key: 'id' } },
    roles: { guest: { clientToServer: { 'chat.send': { input: sendIn, output: sendOut } } } },
    shared: { serverToClient: { 'chat.tick': { payload: tickSchema, subscribe: true } } },
  })
}
// the host merges the fragment's TYPES and separately lists the runtime plugin (handlers/policies live there):
const api = defineContract({ roles: { guest: {}, user: {} }, plugins: [chatPlugin()] })
createSuperLineServer(api, { /* … */ plugins: [chatRuntime()] })  // a fully-owned block (e.g. guest) becomes OPTIONAL in implement()
```

```ts
// A COMPOSED SURFACE — splice a library's requests/events into ONE role, under one connection
import { defineSurface, mergeSurfaces } from '@super-line/core'
export const libSurface = defineSurface({
  clientToServer: { 'lib.join': { input: joinIn, output: joinOut } },
  serverToClient: { 'lib.feed': { payload: feedSchema, subscribe: true } },
})
const api = defineContract({
  roles: { user: { ...mergeSurfaces(libSurface, defineSurface({ clientToServer: { say: sayDef } })), data: userData } },
})                                        // ^ a role's `data:` schema goes BESIDE the merge, never inside it
// mergeSurfaces merges per direction; a duplicate key is a COMPILE error. Prefix keys ('lib.*') to avoid clashes.
```

- A **contract plugin** ships collections + roles + policies as a bundle (a paired runtime plugin carries the handlers); **`mergeSurfaces`** grafts a library's requests/events into an existing role.
- Always wrap with `defineContractPlugin` / `defineSurface` — a plain const widens `subscribe: true` to `boolean` and silently downgrades a topic to a push event.

## Durable CRDT document collection (libsql / Turso)

A durable, mergeable document is a **CRDT document collection** — declared on the contract (so every delta is **validate-before-commit** schema-checked), opened by id, and persisted to libsql/Turso. The factory is **async** — it rehydrates every doc (history-preserving) before returning.

```ts
// CONTRACT — a `crdt` collection (no `key`; the id is external):
const api = defineContract({
  collections: { scenes: { schema: z.object({ shapes: z.record(z.any()) }), crdt: { mode: 'document' } } },
  roles: { user: { clientToServer: {} } },
})

// server — npm i @super-line/collections-crdt-libsql
import { crdtLibsqlCollections } from '@super-line/collections-crdt-libsql'
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })], authenticate, identify: (c) => c.ctx.uid,
  crdtCollections: await crdtLibsqlCollections({          // ASYNC — await it
    url: 'libsql://my-db.turso.io', authToken: process.env.TURSO_TOKEN, // or url:'file:crdt.db' / ':memory:'
    // table: 'crdt_docs', debounceMs: 250,               // snapshot-per-doc, coalesced
    // docOptions: (n) => ({ mode: 'document' }),         // per-collection DocOptions
  }),
  policies: { scenes: { read: (p, id, snap) => true, write: (p, id) => true } }, // guard shape, deny-by-default
})
await srv.collection('scenes').create('s1', { shapes: {} }) // creation is server-authoritative

// client — the universal CRDT engine (pairs with every tier)
import { crdtCollectionsClient } from '@super-line/collections-crdt-memory'
const client = createSuperLineClient(api, { transport, role: 'user', params: { uid: 'alice' }, crdtCollections: crdtCollectionsClient() })
const doc = client.collection('scenes').open('s1'); await doc.ready // → DocHandle { getSnapshot, set, update, delete(path), deleted, close }
```

## Self-clustering collection (central Postgres + Electric — no adapter)

The `-pglite` collection backends set `clustering: 'self'`: writes hit a central Postgres, ElectricSQL streams each table to every node's in-memory PGlite replica, and that replica drives live delivery. The backend owns its own cross-node sync, so **no `adapter:` is needed** for these collections to fan out across nodes.

```ts
// rows — npm i @super-line/collections-pglite
import { pgliteCollections } from '@super-line/collections-pglite'
const srv = createSuperLineServer(api, {                 // note: no adapter
  transports: [webSocketServerTransport({ server })], authenticate, identify: (c) => c.ctx.uid,
  collections: await pgliteCollections({
    pgUrl: 'postgres://localhost:5432/app',              // source of truth (writes + strong reads)
    electricUrl: 'http://localhost:3000/v1/shape',       // Electric shape endpoint streaming the tables in
    collections: api.collections,                        // typed tables are derived from the contract
  }),
  policies: { /* per-collection read→filter / write→bool */ },
})

// CRDT documents — npm i @super-line/collections-crdt-pglite (central Yjs op-log + per-node Electric→PGlite replica)
import { crdtPgliteCollections } from '@super-line/collections-crdt-pglite'
const srv2 = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })], authenticate, identify: (c) => c.ctx.uid,
  crdtCollections: await crdtPgliteCollections({ pgUrl, electricUrl }),  // validate-before-commit at the ingress node before op-log append
  policies: { scenes: { read: (p, id) => true, write: (p, id) => true } },
})
```

Runnable: `examples/ai-canvas-pglite` (CRDT self-tier).

## Synced state with a CRDT (Yjs / Automerge) — roll your own

For most apps, prefer a built-in **CRDT document collection** (above) — a validated, mergeable, persisted document with a client `DocHandle` and a server co-writer, batteries-included. Roll your own only when you need to **own the wire** (custom rooms, your own message shapes, no collection abstraction). super-line is an ideal transport for a hand-rolled CRDT: keep a doc per room and relay **opaque** update bytes (base64-wrapped, so they ride the default JSON serializer). The **server holds the canonical doc** — so it persists state and can be a **co-writer** — and the doc's update observer is the single fan-out point. An `origin` tag marks who wrote each update so clients can break the echo.

```ts
// contract.ts — carries opaque base64 CRDT bytes
export const api = defineContract({
  shared: {
    serverToClient: {
      update: { payload: z.object({ docId: z.string(), update: z.string(), origin: z.enum(['peer', 'server']) }) }, // shared → room.broadcast
    },
  },
  roles: {
    user: {
      clientToServer: {
        joinDoc: { input: z.object({ docId: z.string() }), output: z.object({ snapshot: z.string() }) },
        pushUpdate: { input: z.object({ docId: z.string(), update: z.string() }), output: z.object({ ok: z.boolean() }) },
      },
    },
  },
})
```

```ts
// server.ts — canonical Y.Doc per room; observer fans out + persists for BOTH client merges and server edits
const docs = new Map<string, Y.Doc>(), store = new Map<string, Uint8Array>() // swap store for a DB to persist
function getDoc(docId: string): Y.Doc {
  const live = docs.get(docId); if (live) return live
  const doc = new Y.Doc(); const saved = store.get(docId); if (saved) Y.applyUpdate(doc, saved)
  doc.on('update', (update, origin) => {
    store.set(docId, Y.encodeStateAsUpdate(doc))
    srv.room(`doc:${docId}`).broadcast('update', { docId, update: b64(update), origin: origin === 'server' ? 'server' : 'peer' })
  })
  docs.set(docId, doc); return doc
}
srv.implement({
  user: {
    joinDoc: async ({ docId }, _c, conn) => { const d = getDoc(docId); srv.room(`doc:${docId}`).add(conn); return { snapshot: b64(Y.encodeStateAsUpdate(d)) } },
    pushUpdate: async ({ docId, update }) => { Y.applyUpdate(getDoc(docId), unb64(update), 'client'); return { ok: true } }, // applying a seen update is a no-op
  },
})
// server as co-writer: doc.transact(() => …, 'server') → the same observer fans it out like any client edit
```

```ts
// client.ts — local Y.Doc; push local edits, apply remote ones (origin breaks the echo)
const doc = new Y.Doc()
doc.on('update', (u, origin) => { if (origin === 'local') void client.pushUpdate({ docId, update: b64(u) }) })
client.on('update', (m) => { if (m.docId === docId) Y.applyUpdate(doc, unb64(m.update), m.origin) })
await client.joinDoc({ docId }).then(({ snapshot }) => Y.applyUpdate(doc, unb64(snapshot), 'sync'))
// b64/unb64 = base64 ⇄ Uint8Array (btoa/atob work in the browser and Node 22+)
```

- **CRDT-agnostic** — the wire is opaque bytes, so Automerge (`getChanges`/`applyChanges`, or its `generateSyncMessage` sync protocol) drops in with the same contract.
- **Multi-node free** — `room.broadcast` fans across nodes via the adapter; the origin-node echo-break you use on the bus applies to CRDT bytes too.
- **At-most-once still applies** — an offline client misses live updates; re-`joinDoc` on reconnect to re-snapshot.
- **Authority is reactive, not preventive** — a CRDT can't veto a partial update; the server can only react (observe merged state, emit a compensating edit). Route hard gates (money, permissions) through a normal request instead.
- Runnable: the [`synced-canvas-yjs` / `synced-canvas-automerge`](https://github.com/mertdogar/super-line/tree/main/examples) examples (with a live state + patch debug panel).

## Typed error handling

```ts
import { SuperLineError } from '@super-line/core'

// server
throw new SuperLineError('NOT_FOUND', 'no such room', { room })   // code reaches the client

// client
try { await client.send({ room, text }) }
catch (e) {
  if (e instanceof SuperLineError && e.code === 'UNAUTHORIZED') relogin()
  // codes: BAD_REQUEST UNAUTHORIZED FORBIDDEN NOT_FOUND TIMEOUT VALIDATION DISCONNECTED INTERNAL
}
```

## Reconnect & delivery — design for it

- Delivery is **at-most-once**; messages sent while a client is offline are dropped (no replay yet).
- Make handlers **idempotent**; after a reconnect the client auto-re-subscribes topics but must **re-run room joins**.
- In-flight requests reject `DISCONNECTED` on drop; calls during reconnect are queued and flushed.
- A 401 looks like any drop over the WS API, so a bad-credential client retries forever unless you set `reconnect: false`.

## Control Center (live inspector)

The read-only inspector ships as the plugin `@super-line/plugin-inspector` and is **off by default**. Mount it with `plugins: [inspector()]` — it contributes the `msg.*` telemetry tap and the reserved connection class the WS transport negotiates (`superline.inspector.v1`) — then point the dashboard at the node. Dev / trusted-network only.

```ts
import { inspector } from '@super-line/plugin-inspector'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  plugins: [inspector({ redact: ['token', 'password'] })], // inspector() alone, or mask ctx/data keys in telemetry
})
```

```bash
npx @super-line/control-center --url ws://localhost:3000   # opens the SPA; --url seeds the default connection
```

Telemetry fans out cluster-wide over the adapter, so one dashboard sees every node's traffic (requests · events · broadcasts · publishes · collection/CRDT writes), live topology, and presence.

## Testing

Test super-line by booting a **real server** on an ephemeral port and a **real client** (exercises the actual handshake + frames), then asserting through two kinds of "hooks":

- **Server lifecycle hooks** (`onConnection`, `onDisconnect`, `onError`) — observation seams: capture the server-side `conn`, count connects, assert disconnects, capture server-side errors.
- **React hooks** — render `useRequest` / `useSubscription` / `useEvent` against a real client with `renderHook`.

These snippets are distilled from super-line's own (passing) suite. They use [Vitest](https://vitest.dev).

### A tiny harness (reuse across tests)

```ts
// test/harness.ts
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Contract, RoleOf } from '@super-line/core'
import { createSuperLineServer, type AuthResult, type SuperLineServerOptions, type SuperLineServer } from '@super-line/server'
import { createSuperLineClient, type SuperLineClient, type SuperLineClientOptions } from '@super-line/client'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'

export function createHarness() {
  const cleanups: Array<() => Promise<void> | void> = []

  async function server<C extends Contract, A extends AuthResult<C>>(
    contract: C, opts: Omit<SuperLineServerOptions<C, A>, 'transports'>,
  ): Promise<{ srv: SuperLineServer<C, A>; url: string }> {
    const httpServer = http.createServer()
    const srv = createSuperLineServer<C, A>(contract, { ...opts, transports: [webSocketServerTransport({ server: httpServer })] })
    await new Promise<void>((r) => httpServer.listen(0, r))
    const url = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
    cleanups.push(async () => { await srv.close(); await new Promise<void>((r) => httpServer.close(() => r())) })
    return { srv, url }
  }
  function client<C extends Contract, R extends RoleOf<C>>(contract: C, opts: Omit<SuperLineClientOptions<C, R>, 'transport'> & { url: string }): SuperLineClient<C, R> {
    const { url, ...rest } = opts
    const c = createSuperLineClient(contract, { ...rest, transport: webSocketClientTransport({ url }) })
    cleanups.unshift(() => c.close())          // clients close BEFORE the servers they connect to
    return c
  }
  async function dispose() { for (const fn of cleanups.splice(0)) await fn() }
  return { server, client, dispose }
}

export const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms))
export async function waitFor(pred: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!pred()) { if (Date.now() - start > timeout) throw new Error('waitFor timeout'); await tick(5) }
}
```

A shared contract for the examples below:

```ts
import { z } from 'zod'
import { defineContract } from '@super-line/core'
export const api = defineContract({
  shared: { serverToClient: { ping: { payload: z.object({ n: z.number() }) } } },
  roles: {
    user: {
      clientToServer: {
        echo: { input: z.object({ text: z.string() }), output: z.object({ text: z.string() }) },
        boom: { input: z.object({}), output: z.object({ ok: z.boolean() }) },
      },
      serverToClient: {
        feed: { payload: z.object({ n: z.number() }), subscribe: true },
        secret: { payload: z.object({ x: z.string() }), subscribe: true },
      },
    },
  },
})
```

### Round-trip + typed error

```ts
import { afterEach, expect, it } from 'vitest'
import { SuperLineError } from '@super-line/core'
import { createHarness } from './harness'
import { api } from './api'

const h = createHarness()
afterEach(() => h.dispose())

it('round-trips and surfaces typed errors', async () => {
  const { srv, url } = await h.server(api, { authenticate: () => ({ role: 'user' as const, ctx: {} }) })
  srv.implement({
    user: {
      echo: async ({ text }) => ({ text }),
      boom: async () => { throw new SuperLineError('FORBIDDEN', 'nope') },
    },
  })
  const client = h.client(api, { url, role: 'user' })
  expect(await client.echo({ text: 'hi' })).toEqual({ text: 'hi' })
  await expect(client.boom({})).rejects.toMatchObject({ code: 'FORBIDDEN' })
})
```

### Role enforcement (cross-role → NOT_FOUND)

```ts
it('rejects a cross-role call with NOT_FOUND', async () => {
  const { srv, url } = await h.server(twoRoleApi, { authenticate: (h) => resolveRole(h) })
  srv.implement({ user: { sendMessage: async () => ({ id: '1' }) }, agent: { reportResult: async () => ({ ok: true }) } })

  const user = h.client(twoRoleApi, { url, role: 'user' })
  // bypass the typed surface to prove the runtime boundary
  const call = (user as unknown as { reportResult: (i: unknown) => Promise<unknown> }).reportResult({ taskId: 't1' })
  await expect(call).rejects.toMatchObject({ code: 'NOT_FOUND' })
})
```

### Lifecycle hooks as test seams

```ts
import type { Conn } from '@super-line/server'

it('observes connect / disconnect / errors via hooks', async () => {
  const events: string[] = []
  let captured: Conn | undefined
  const { srv, url } = await h.server(api, {
    authenticate: () => ({ role: 'user' as const, ctx: { id: 'u1' } }),
    onConnection: (conn) => { captured = conn; events.push('connect') },
    onDisconnect: () => events.push('disconnect'),
    onError: (err) => events.push(`error:${(err as SuperLineError).code}`),
  })
  srv.implement({ user: { echo: async ({ text }) => ({ text }), boom: async () => { throw new SuperLineError('FORBIDDEN') } } })

  const client = h.client(api, { url, role: 'user', reconnect: false })
  await client.echo({ text: 'x' })
  expect(events).toContain('connect')
  expect(captured?.role).toBe('user')          // the captured server-side conn carries role + ctx

  await expect(client.boom({})).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(events).toContain('error:FORBIDDEN')  // onError saw the thrown SuperLineError

  client.close()
  await waitFor(() => events.includes('disconnect'))
})
```

### Auth: reject at the upgrade (no socket)

```ts
it('rejects a bad token and never opens a socket', async () => {
  let connects = 0
  const { srv, url } = await h.server(api, {
    authenticate: (h) => {
      const token = h.query.token
      if (token !== 'good') throw new Error('unauthorized')
      return { role: 'user' as const, ctx: {} }
    },
    onConnection: () => { connects++ },
  })
  srv.implement({ user: { echo: async ({ text }) => ({ text }), boom: async () => ({ ok: true }) } })

  // reconnect:false so the failure surfaces immediately (a 401 looks like any drop over the WS API)
  const client = h.client(api, { url, role: 'user', params: { token: 'bad' }, reconnect: false })
  await expect(client.echo({ text: 'x' })).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(connects).toBe(0)
})
```

### Topics: authorize + deliver

```ts
it('denies an unauthorized subscribe and delivers an authorized one', async () => {
  const { srv, url } = await h.server(api, {
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    authorizeSubscribe: (topic) => topic !== 'secret',
  })
  srv.implement({ user: { echo: async ({ text }) => ({ text }), boom: async () => ({ ok: true }) } })
  const client = h.client(api, { url, role: 'user' })

  await expect(client.subscribe('secret', () => {}).ready).rejects.toMatchObject({ code: 'FORBIDDEN' })

  const got: number[] = []
  await client.subscribe('feed', (p) => got.push(p.n)).ready
  srv.forRole('user').publish('feed', { n: 1 })
  await waitFor(() => got.length === 1)
})
```

### Reconnect: simulate a drop with `conn.terminate()`

```ts
import type { Conn } from '@super-line/server'

it('auto-reconnects, re-subscribes, and rejects in-flight on drop', async () => {
  let last: Conn | undefined
  const { srv, url } = await h.server(api, { authenticate: () => ({ role: 'user' as const, ctx: {} }), onConnection: (c) => { last = c } })
  srv.implement({ user: { echo: async ({ text }) => ({ text }), boom: () => new Promise<never>(() => {}) /* hangs */ } })
  const client = h.client(api, { url, role: 'user', reconnectBaseMs: 10, reconnectMaxMs: 50 })

  const got: number[] = []
  await client.subscribe('feed', (p) => got.push(p.n)).ready

  const inflight = client.boom({})              // never resolves server-side
  await tick(20)                                // ensure it's sent
  const first = last
  first!.terminate()                            // simulate a network drop

  await expect(inflight).rejects.toMatchObject({ code: 'DISCONNECTED' })   // in-flight rejects
  await waitFor(() => last !== first && client.connected, 3000)            // reconnected (new conn)
  srv.forRole('user').publish('feed', { n: 1 })
  await waitFor(() => got.length === 1, 3000)                              // topic auto-re-subscribed
})
```

### Cross-node without Redis (shared in-memory bus)

```ts
import { MemoryBus, createInMemoryAdapter } from '@super-line/server'

it('fans out across two nodes sharing one bus', async () => {
  const bus = new MemoryBus()
  const a = await h.server(api, { authenticate: () => ({ role: 'user' as const, ctx: {} }), adapter: createInMemoryAdapter(bus) })
  const b = await h.server(api, { authenticate: () => ({ role: 'user' as const, ctx: {} }), adapter: createInMemoryAdapter(bus) })
  for (const n of [a, b]) n.srv.implement({ user: { echo: async ({ text }) => ({ text }), boom: async () => ({ ok: true }) } })

  const client = h.client(api, { url: a.url, role: 'user' })  // connected to node A only
  const got: number[] = []
  await client.subscribe('feed', (p) => got.push(p.n)).ready
  b.srv.forRole('user').publish('feed', { n: 7 })             // published on node B
  await waitFor(() => got.length === 1)                       // received on node A
})
```

### Cluster event bus across nodes

`server.subscribe` fires on **every** node for a publish — the origin node via in-process local echo (no Redis hop), peers via the adapter. Assert each listener fires exactly once; self-exclude with `meta.from`.

```ts
// busApi: shared.serverToClient.rebalance = { payload: z.object({ shard: z.number() }), subscribe: true }

it('one publish fires server.subscribe on both nodes exactly once', async () => {
  const bus = new MemoryBus()
  const a = await h.server(busApi, { authenticate: () => ({ role: 'user' as const, ctx: {} }), adapter: createInMemoryAdapter(bus) })
  const b = await h.server(busApi, { authenticate: () => ({ role: 'user' as const, ctx: {} }), adapter: createInMemoryAdapter(bus) })

  const aGot: unknown[] = [], bGot: unknown[] = []
  a.srv.subscribe('rebalance', (d, { from }) => { expect(from).toBe(a.srv.nodeId); aGot.push(d) }) // origin: local echo, in-process
  b.srv.subscribe('rebalance', (d, { from }) => { expect(from).toBe(a.srv.nodeId); bGot.push(d) }) // peer: over the bus, inbound-validated
  a.srv.publish('rebalance', { shard: 3 })

  await waitFor(() => aGot.length === 1 && bGot.length === 1)
  await tick(30)
  expect(aGot).toEqual([{ shard: 3 }])             // origin fired once (no duplicate from a Redis round-trip)
  expect(bGot).toEqual([{ shard: 3 }])
})
```

### React hooks (`renderHook`)

```ts
// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createSuperLineHooks } from '@super-line/react'
import { createHarness } from './harness'
import { api } from './api'

const { Provider, useRequest } = createSuperLineHooks<typeof api, 'user'>()
const h = createHarness()
afterEach(() => { cleanup(); return h.dispose() })

it('useRequest performs a typed call and exposes state', async () => {
  const { srv, url } = await h.server(api, { authenticate: () => ({ role: 'user' as const, ctx: {} }) })
  srv.implement({ user: { echo: async ({ text }) => ({ text }), boom: async () => ({ ok: true }) } })
  const client = h.client(api, { url, role: 'user' })

  const wrapper = ({ children }: { children: ReactNode }) => createElement(Provider, { client, children })
  const { result } = renderHook(() => useRequest('echo'), { wrapper })

  await act(async () => { await result.current.call({ text: 'hi' }) })
  expect(result.current.data).toEqual({ text: 'hi' })
  expect(result.current.isLoading).toBe(false)
})
```

### Tips

- **Close the client before the server** — an open connection blocks `server.close()` (the harness handles this via `unshift`).
- **Skip the socket entirely** — for pure logic tests, swap the WS pair for `createLoopbackTransport()` (in-memory, no port): pass `loopback.server` to `transports:` and `loopback.client()` to `transport:`. Same handshake + frames, no `http.Server`.
- **Return `role` as a literal** from `authenticate` (`role: 'user' as const`) so it's inferred as the role key, not widened to `string`.
- `backoffDelay` is a **pure function** — unit-test it directly (no timers or sockets): `expect(backoffDelay(0, opts)).toBeLessThanOrEqual(opts.maxMs)`.
- Prefer a small `reconnectBaseMs` + `waitFor` over fake timers — `vi.useFakeTimers()` is brittle alongside real sockets (real I/O isn't faked).
- For **real cross-process** tests, use `testcontainers` + `createRedisAdapter(url)`, and skip cleanly when Docker is absent (`describe.skipIf`). For a cross-node **room** broadcast, `room.add → adapter.subscribe` is fire-and-forget, so poll the broadcast until it lands (the SUBSCRIBE-propagation window is a non-issue in real apps).
