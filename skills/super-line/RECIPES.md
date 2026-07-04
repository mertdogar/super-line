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

## Stores (permissioned real-time documents)

A **Store** is the built-in, off-contract persisted-state seam: named, permissioned JSON Resources `{ id, accessRules, data }` with a reactive client handle, a server-side co-writer, and a pluggable backend (in-memory LWW, a merging CRDT, or durable SQLite). Configure a server + client **pair** under matching keys.

```ts
// server — pick a backend per name; everything else is identical
import { memoryStoreServer } from '@super-line/store-memory'      // LWW (default)
// import { syncStoreServer } from '@super-line/store-sync'       // CRDT (merging) — one-line swap
// import { sqliteStoreServer } from '@super-line/store-sqlite'   // durable LWW
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid } }),
  identify: (conn) => conn.ctx.uid,                                // the ACL principal
  stores: { docs: memoryStoreServer() },
})
// server-authoritative lifecycle (NO client wire for these); deny-by-default
await srv.store('docs').create('note-1', { title: 'Draft', body: '' }, { alice: { read: true, write: true } })
await srv.store('docs').grant('note-1', 'bob', { read: true, write: false })   // open access at runtime
```

```ts
// client — the matching half under the same key
import { memoryStoreClient } from '@super-line/store-memory'
const client = createSuperLineClient(api, {
  transport: webSocketClientTransport({ url }), role: 'user', params: { uid: 'alice' },
  stores: { docs: memoryStoreClient() },
  onStoreError: (err, { store, id }) => console.warn('write denied', store, id, err),  // optimistic: no rollback
})
const note = client.store('docs').open<{ title: string; body: string }>('note-1')
await note.ready                              // getSnapshot() is undefined until catch-up
note.subscribe(() => render(note.getSnapshot()))
note.update({ title: 'Shipping plan' })       // optimistic + fanned to other subscribers
note.delete(['body'])                         // surgical key removal (merges; a full `set` would clobber a peer)
note.close()
```

```ts
// server-side co-writer — for an IN-PROCESS AI agent / bot / validator. NOT a loopback client:
const h = srv.store('docs').open('note-1', { origin: 'agent:42' })
h.subscribe(() => render(h.getSnapshot()))    // reactive reads — sees clients' edits live
h.update({ title: 'Curated' })                // merge a co-write
h.delete(['body'])                            // the ONLY way to delete a key server-side (write/update merge)
h.close()
```

- **One plumbing, two consistency models** — swap the `memory*` pair for `syncStoreServer()`/`syncStoreClient()` to go from last-writer-wins to a **merging CRDT** (concurrent edits to different fields converge). Nothing else changes; for document-mode merge pass the SAME `resolveOptions` to both halves.
- **Off-contract + unknown** — `data` is never schema-validated; assert the shape (`open<T>`). Route hard typed gates through a request (ADR-0003).
- **Merge vs delete** — `update`/`write` merge top-level keys (never remove one); `delete(path)` is the only key removal. On the CRDT store it's surgical and merge-safe; use `set` only for a whole-document replace.
- **In-process actor?** Use the server co-writer (`srv.store(ns).open(id)`), not a loopback client — reactive reads + delete, server-authoritative, no grant.
- Runnable: the [`store`](https://github.com/mertdogar/super-line/tree/main/examples/store) (LWW) and [`store-sync-json`](https://github.com/mertdogar/super-line/tree/main/examples/store-sync-json) (CRDT) examples; [`ai-canvas`](https://github.com/mertdogar/super-line/tree/main/examples/ai-canvas) is the agent co-writer end-to-end — a server-side LLM edits a shared canvas via `open(id)` (`update` + `delete(path)`), merging with users' concurrent edits.

## Durable CRDT store (libsql / Turso)

Same `syncStoreServer` CRDT merge engine as `store-sync`, snapshotted per Resource to libsql so state survives a restart. The factory is **async** — it rehydrates every Resource (history-preserving) before returning. Client half is the plain `syncStoreClient()`.

```ts
// server — npm i @super-line/store-sync-libsql
import { libsqlSyncStore } from '@super-line/store-sync-libsql'
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })], authenticate, identify: (c) => c.ctx.uid,
  stores: {
    docs: await libsqlSyncStore({                       // ASYNC — await it
      url: 'libsql://my-db.turso.io', authToken: process.env.TURSO_TOKEN, // or url:'file:store.db' / ':memory:'
      // table: 'resources', debounceMs: 250,           // coalesce rapid edits into one snapshot write
      // resolveOptions: (id) => ({ mode: 'document' }), // MUST match the client's (the store-sync rule)
    }),
  },
})
// client — the SAME CRDT half as store-sync (durability is a server-side concern)
import { syncStoreClient } from '@super-line/store-sync'
const client = createSuperLineClient(api, { transport, role: 'user', params: { uid: 'alice' }, stores: { docs: syncStoreClient() } })
```

## Self-clustering store (central Postgres + Electric — no adapter)

`store-pglite` / `store-sync-pglite` set `clustering: 'self'`: writes hit a central Postgres, ElectricSQL streams the table to each node's in-memory PGlite replica, and `live.changes` drives `onChange`/`onDelete`. The store owns its own cross-node sync, so **no `adapter:` is needed** for these Resources to fan out across nodes.

```ts
// LWW — npm i @super-line/store-pglite ; pair with memoryStoreClient()
import { pgliteStoreServer } from '@super-line/store-pglite'
const srv = createSuperLineServer(api, {                 // note: no adapter
  transports: [webSocketServerTransport({ server })], authenticate, identify: (c) => c.ctx.uid,
  stores: {
    docs: await pgliteStoreServer({
      pgUrl: 'postgres://localhost:5432/app',            // source of truth (writes + strong reads + ACL)
      electricUrl: 'http://localhost:3000/v1/shape',     // Electric shape endpoint streaming the table in
    }),
  },
})

// CRDT sibling — npm i @super-line/store-sync-pglite ; pair with syncStoreClient(); supports open()→ServerReplica
import { syncPgliteStoreServer } from '@super-line/store-sync-pglite'
const docs = await syncPgliteStoreServer({ pgUrl, electricUrl, resolveOptions: (id) => ({ mode: 'document' }) })
const replica = srv.store('docs').open('note-1')         // reactive in-process co-writer (CRDT op-log under the hood)
```

## Observe deletion on the client (the `deleted` flag)

`srv.store(ns).delete(id)` fans a deletion cluster-wide (wire `sdel`); every open client handle flips `deleted: true` and fires its `subscribe` so the UI can re-read. Works on any backend, any node.

```ts
// server — authoritative deletion (no client wire for this)
await srv.store('docs').delete('note-1')      // fans out everywhere; ServerStore.onDelete also fires server-side

// client (vanilla)
const note = client.store('docs').open('note-1')
note.subscribe(() => { if (note.deleted) showTombstone(); else render(note.getSnapshot()) })

// React
const { data, deleted } = useResource('docs', 'note-1')
if (deleted) return <Tombstone />
```

## Synced state with a CRDT (Yjs / Automerge) — roll your own

For most apps, prefer the built-in **Store** seam above — `store-sync` is exactly this CRDT relay, batteries-included. Roll your own only when you need to **own the wire** (custom rooms, your own message shapes, no Store abstraction). super-line has no built-in shared-document type, but it's an ideal transport for one: keep a CRDT doc per room and relay **opaque** update bytes (base64-wrapped, so they ride the default JSON serializer). The **server holds the canonical doc** — so it persists state and can be a **co-writer** — and the doc's update observer is the single fan-out point. An `origin` tag marks who wrote each update so clients can break the echo.

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

The read-only inspector is **server-authoritative and off by default**. Turn it on in **two** places — server opts (gates the `msg.*` telemetry) and the WS transport (negotiates the `superline.inspector.v1` subprotocol) — then point the dashboard at the node. Dev / trusted-network only.

```ts
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server, inspector: true })], // negotiate the inspector subprotocol
  authenticate,
  inspector: { redact: ['token', 'password'] },                         // true, or mask ctx/data keys in telemetry
})
```

```bash
npx @super-line/control-center --url ws://localhost:3000   # opens the SPA; --url seeds the default connection
```

Telemetry fans out cluster-wide over the adapter, so one dashboard sees every node's traffic (requests · events · broadcasts · publishes), live topology, and presence.

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
```
