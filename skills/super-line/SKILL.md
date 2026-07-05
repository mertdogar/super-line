---
name: super-line
description: Use when building realtime features with super-line — TypeScript/JavaScript that imports from @super-line/core, @super-line/server, @super-line/client, @super-line/adapter-redis (or -libp2p / -rabbitmq / -zeromq), @super-line/react, @super-line/store-memory, @super-line/store-sync, @super-line/store-sqlite, @super-line/store-sync-libsql, @super-line/store-pglite, or @super-line/store-sync-pglite, or when the user mentions super-line. Covers the one contract split by direction (clientToServer/serverToClient) and scoped by role (a shared base plus per-role surfaces); the interaction flavors (req/res requests, server-pushed events, client-subscribed topics, server-controlled rooms, the cluster event bus — a symmetric cluster-wide pub/sub on a shared topic via server.publish / server.subscribe / client.subscribe — and server→client requests where the server asks a client and awaits a typed reply via toConn.request / client.implement); permissioned realtime Stores (off-contract JSON Resources with per-client ACLs — LWW or merging-CRDT models across in-memory, durable (SQLite, libsql/Turso), and self-clustering (Postgres+Electric→PGlite) backends — with a reactive client handle, a cross-node `deleted` signal, and an in-process server-side co-writer via srv.store(ns).open(id)); upgrade-time auth that returns { role, ctx }, role enforcement (cross-role calls get NOT_FOUND), the typed SuperLineError model; connection introspection and presence (srv.local for this node, srv.cluster for the whole fleet — connection counts, topology, isOnline, byUser); targeted cross-node send and disconnect (srv.toConn(id) / srv.toUser(uid)); heartbeat liveness (lastPongAt) and zombie reaping; typed per-connection state (conn.data); backpressure; client reconnect and at-most-once delivery; multi-node scaling and the presence registry via the Redis adapter; testing over a real loopback server; and common pitfalls. Also reach for this skill when the user asks how to count or list connections, check who's online, broadcast or send to a specific user/connection across servers, fan a publish out cluster-wide to servers and clients at once, ask a connected client a question, track presence, store and sync shared permissioned state, build a collaborative document, let a server-side AI agent or bot co-edit one, or shape a typed WebSocket contract — even if they don't name super-line. Not for socket.io, ws, or tRPC.
---

# super-line

A strictly-typed realtime data bus for TypeScript — one contract for every pattern on the wire (requests · events · subscriptions · synced state). **One contract is the single source of truth** — the server implements it, the client calls it, types flow end to end with no codegen. WebSocket is just the default transport (HTTP/SSE, libp2p, and loopback are swappable).

Human-facing docs (guides + full generated API reference): <https://super-line.dogar.biz/>. This skill is the condensed, prescriptive version for agents. For machine-readable docs: append `.md` to any docs page URL for its raw markdown, fetch <https://super-line.dogar.biz/llms.txt> for an index of every page, or <https://super-line.dogar.biz/llms-full.txt> for the entire documentation in one file.

## Mental model — read this first

There is exactly **one contract**, defined once and imported by **both** sides. It is split by **direction** and scoped by **role**:

```ts
// contract.ts — shared by server AND client (a shared module/package)
import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const api = defineContract({
  shared: {                       // every role gets these
    clientToServer: { /* requests */ },
    serverToClient: { /* events + topics */ },
  },
  roles: {                        // each role sees shared ∪ its own surface
    user:  { clientToServer: {…}, serverToClient: {…} },
    agent: { clientToServer: {…}, serverToClient: {…} },
  },
})
```

- A **connection has a role**, decided at the upgrade from auth, fixed for its life. Each role gets a different typed surface *and* a different `ctx`.
- **Direction is the axis** (named keys, never positional generics). **Per entry:**
  - `clientToServer: { name: { input, output } }` → **request** (awaited, typed errors, timeout).
  - `serverToClient: { name: { payload } }` → **event** (server pushes to chosen recipients).
  - `serverToClient: { name: { payload, subscribe: true } }` → **topic** (client opts in via `subscribe`). A **shared** topic doubles as a **cluster event bus channel** — see below.
- **Server**: `createSuperLineServer(api, { transports: [webSocketServerTransport({ server })], authenticate })`, then `srv.implement({ shared, user, agent })`. The WS transport comes from `@super-line/transport-websocket`; alternatives are `@super-line/transport-http` (SSE/long-poll), `@super-line/transport-libp2p` (libp2p/WebRTC, BYO node), and `@super-line/transport-loopback` (in-memory, for tests) — see the Transports guide.
- **Client**: `createSuperLineClient(api, { transport: webSocketClientTransport({ url }), role: 'user' })` → a typed proxy narrowed to that role's surface.
- **No codegen.** Put the contract in a module both import. Never re-declare types on one side.

## The interaction flavors — pick the right one

| Flavor | Contract location | Direction | Who initiates | Use for |
|---|---|---|---|---|
| **request** | `clientToServer: { input, output }` | client → server → client (one reply) | client | actions/queries: `send`, `join`, `getHistory` |
| **event** | `serverToClient: { payload }` | server → client (push) | server picks recipients | room broadcasts, notifications, direct push |
| **topic** | `serverToClient: { payload, subscribe: true }` | server → many clients | **client** subscribes (server authorizes) | live streams: prices, presence, feeds |
| **room** | server API | server → members | **server** controls (`add`/`remove`) | grouping conns to broadcast a shared event |
| **server→client request** | `serverToClient: { input, output }` | server → client → server (one reply) | server | asking a client: `confirm`, `sync`, capability probe |
| **cluster event bus** | **shared** topic (`serverToClient: { payload, subscribe: true }`) | any node → all servers + all subscribed clients | anyone (`server.publish`) | cluster-wide pub/sub: gossip, fleet-wide tallies, coordination + a client-facing stream from one declaration |
| **store** | **off-contract** (`stores:` pair) | server-authoritative read/write, fanned out | server creates + grants; client `open`s a Resource | permissioned real-time JSON documents — shared config, collab scenes, agent/bot co-writers |

Decide: **Need a reply?** request. **Pushing to recipients *you* pick?** event (often via `room.broadcast`). **Clients opting into a stream?** topic. **Coordinating other server processes (and optionally clients) on a symmetric channel?** the **cluster event bus** — a shared topic with `server.publish` + `server.subscribe` + `client.subscribe`. **Shared mutable state with per-client permissions that stays live?** a **Store**.

## Quick reference

| Need | Do |
|---|---|
| Define contract | `defineContract({ shared, roles })` (schemas = any Standard Schema validator; Zod in examples) |
| Server | `const srv = createSuperLineServer(api, { transports: [webSocketServerTransport({ server })], authenticate }); srv.implement({ shared, user, agent })` (`webSocketServerTransport` from `@super-line/transport-websocket`) |
| Authenticate | `authenticate: (h) => ({ role: 'user', ctx })` — `throw` to reject (401). Read the claimed role from the `Handshake` (`h.query.role` / `h.headers`) and verify it. |
| Handler | `name: async (input, ctx, conn) => output` — `ctx`/`conn` narrowed to the block's role |
| Reply error | `throw new SuperLineError('FORBIDDEN', 'msg')` → client promise rejects with that typed code |
| Send to one conn | `conn.emit('event', data)` (scoped to the conn's role events) |
| Broadcast to a room | `srv.room('room:42').broadcast('event', data)` — **shared events only** (mixed-role room) |
| Publish a role topic | `srv.forRole('user').publish('feed', data)` — **server only** |
| Publish a shared topic | `srv.publish('announce', data)` — **server only** (any node; this IS the bus publish) |
| Cluster event bus | `srv.publish('announce', data)` (any node) · `srv.subscribe('announce', (data, { from }) => …)` (server-side, cluster-wide, **local echo**, returns unsubscribe) · `client.subscribe('announce', (data) => …)` (over WS) — all from ONE shared topic |
| Self-exclude on the bus | `srv.subscribe('announce', (data, { from }) => { if (from === srv.nodeId) return; … })` — you hear your own publish |
| Client | `const client = createSuperLineClient(api, { transport: webSocketClientTransport({ url }), role: 'user' })` (`webSocketClientTransport` from `@super-line/transport-websocket`) |
| Client call | `await client.send(input, { timeoutMs?, signal? })` |
| Client listen | `client.on('event', (d) => …)` → returns unsubscribe |
| Client subscribe | `const sub = client.subscribe('feed', (d) => …); await sub.ready; sub.unsubscribe()` |
| Multi-node | pass an `adapter:` to every server — `createRedisAdapter('redis://…')` (or `-libp2p` / `-rabbitmq` / `-zeromq`, each has a `scaling-*` example). A `clustering:'self'` store needs **none** (it owns its own sync) |
| Transport | server `transports: [webSocketServerTransport({ server })]` · client `transport: webSocketClientTransport({ url })`; swap in `httpServerTransport`/`httpClientTransport` (SSE/long-poll), `libp2p*Transport` (BYO node), or `loopback*Transport` (tests) |
| Control Center (debug) | `createSuperLineServer(api, { …, plugins: [inspector()] })` (from `@super-line/plugin-inspector`; `inspector({ redact: ['token'] })` to mask fields), then `npx @super-line/control-center` → cluster-wide live feed of `msg.*` traffic + topology |
| React | `const { Provider, useRequest, useEvent, useSubscription } = createSuperLineHooks<typeof api, 'user'>()` |
| Store (server) | `stores: { docs: <server-half> }`, then `srv.store('docs').create/grant/revoke/write/read/list/delete` (server-authoritative, off-contract). **Halves — model · durability · clustering:** `memoryStoreServer()` LWW·mem·relay · `syncStoreServer()` CRDT·mem·relay · `sqliteStoreServer({ file })` LWW·durable·relay · `await libsqlSyncStore({ url, authToken? })` CRDT·durable(Turso/sqld)·relay · `await pgliteStoreServer({ pgUrl, electricUrl? })` LWW·**self** · `await syncPgliteStoreServer({ pgUrl, electricUrl? })` CRDT·**self** (libsql/pglite factories are **async** — `await`) |
| Store co-writer (server) | `const h = srv.store('docs').open(id, { origin? })` → reactive `{ getSnapshot, subscribe, update, set, delete(path), close }` — in-process, the **only** way to delete a key server-side. `srv.store(ns).delete(id)` removes a Resource and fans the deletion cluster-wide (`ServerStore.onDelete`) |
| Store (client) | client half matches the server's **model**: `memoryStoreClient({ origin? })` for LWW (memory/sqlite/pglite) · `syncStoreClient({ resolveOptions?, origin? })` for CRDT (sync/libsql/sync-pglite). `const h = client.store('docs').open(id)` → `{ getSnapshot, subscribe, set, update, delete(path), deleted, ready, close }`; one-shot `client.store('docs').read/write(id, …)` |
| Store (React) | `const { data, deleted, set, update, delete: del } = useResource<T>('docs', id)` |
| **Collections** (typed rows — the LWW-store successor) | Declare on the contract (`collections: { messages: { schema, key, references? } }`); server takes ONE backend (`memoryCollections()` · `sqliteCollections({file})` · `await pgliteCollections({pgUrl})`) + row `policies` (deny-by-default `read`→IR filter / `write`→bool). Client `client.collection('messages').subscribe({filter,orderBy,limit})` → live row-set + `insert/update/delete/batch`; React `useCollection`. Joins/live-queries via `@super-line/tanstack-db` + TanStack DB. `srv.collection(n)` server co-write. See REFERENCE.md → Collections |
| Local introspection (sync) | `srv.local.connections` / `.rooms` / `.topics`; `srv.room('x').connections`; `conn.id`/`connectedAt`/`lastPongAt`; filter with plain JS |
| Cluster introspection (async) | `await srv.cluster.connections()` / `.count()` / `.byUser(uid)` / `.room(n)` / `.topology()`; `await srv.isOnline(uid)` — needs `identify` + presence adapter |
| Identify a conn for cluster | `identify: (conn) => conn.ctx.userId`, `describeConn: (conn) => ({ plan })` in server opts (ctx never auto-serialized) |
| Targeted cross-node send | `srv.toConn(id).emit('ev', d)` / `srv.toUser(uid).emit('ev', d)` (shared events); `srv.toConn(id).close()` / `srv.toUser(uid).disconnect()` |
| Ask a client (server→client req) | server: `await srv.toConn(id).request('confirm', input, { timeout?, signal? })`; client: `client.implement({ confirm: async (input) => output })` |
| Heartbeat / reaping | `heartbeat: { interval: 30_000, maxMissed: 2 }` (or `false`) in server opts; read `conn.lastPongAt` |
| Per-conn state | declare `data:` schema in a role block → `conn.data` typed per role, mutable, starts `{}` |
| Backpressure | `backpressure: { maxBufferedBytes, onExceed: 'close' | 'drop' }` in server opts |

Full signatures → **REFERENCE.md**. End-to-end best-practice patterns (roles, auth, presence, DMs, scaling, the cluster event bus, testing) → **RECIPES.md**.

## Rules

- **ALWAYS** keep the contract in one shared module imported by both sides. Never hand-redeclare types.
- **ALWAYS** resolve the role server-side in `authenticate` and return `{ role, ctx }`. The client's `role` option is a *claim*; verify it against the credential (`throw` to reject). Never trust the client's claimed role without checking.
- **ALWAYS** `throw new SuperLineError(code, msg, data?)` from handlers for expected failures — clients get the typed `code`. Unknown throws become `INTERNAL` (no internals leaked).
- **ALWAYS** gate topic subscriptions with `authorizeSubscribe(topic, ctx, conn)` when topics carry private data (return `false` or throw to deny).
- **ALWAYS** treat delivery as **at-most-once**: offline clients miss messages (no replay). Make handlers idempotent; re-run join flows after reconnect; don't assume in-flight requests survive a drop.
- **ALWAYS** add a real adapter before running more than one server process — `@super-line/adapter-redis` (or `-libp2p` / `-rabbitmq` / `-zeromq`; Redis is the default, not the only choice) — otherwise rooms/topics/the cluster event bus/**relay** store fan-out only happen within one node. **Exception:** a `clustering:'self'` store (`store-pglite`, `store-sync-pglite`) owns its own cross-node sync (central Postgres + Electric→PGlite) and needs **no** adapter.
- **ALWAYS** self-exclude on the bus when you don't want to react to your own publish — `server.subscribe` has **local echo**: `if (from === srv.nodeId) return`. The bus fires same-node listeners in-process (no Redis/WS hop); peers arrive via the adapter and are inbound-validated against the topic's payload schema.
- **PREFER** `events` (server picks recipients) over `topics` when the server decides who gets it; use `topics` only for client-initiated subscriptions.
- **PREFER** `srv.local.*` (sync, in-process) for hot-path reads; reach for `srv.cluster.*` only when you genuinely need the whole fleet. Cluster reads hit the adapter (Redis) and are **eventually consistent** — a snapshot, not a transaction. Don't poll them in a tight loop.
- **ALWAYS** seed cluster-descriptor fields (`identify`/`describeConn` inputs, `conn.data`) in `onConnection` — it runs just *before* the presence snapshot. Mutating `conn.data` later in a handler updates the in-process conn but **not** the already-written descriptor.
- **ALWAYS** treat a **Store as off-contract**: `data` is `unknown` end-to-end and is **not** schema-validated (a CRDT delta can't be). Assert the shape yourself, and route anything needing a hard typed gate through a request. Stores are **deny-by-default** — `grant` a principal before it can read or write.
- **PREFER** a server-side co-writer (`srv.store(ns).open(id)`) over a loopback client for an in-process actor (AI agent, bot, validator): it reads reactively and is the only way to **delete** a key server-side. `write`/`update` MERGE top-level keys, so they can add or change but never remove one — use `delete(path)` to remove. Store writes are optimistic + fire-and-forget; a rejection routes to `onStoreError` with no auto-rollback.
- **NEVER** trust client input — the server validates inbound automatically, but don't bypass it; keep schemas tight.

## Pitfalls

- **A request belongs to exactly one role's surface (plus `shared`).** A cross-role or unknown method is rejected with **`NOT_FOUND`** at runtime — the client-side types already hide it, so this only bites if you bypass them.
- **Rooms are mixed-role; `broadcast` takes SHARED events only.** To push a role-specific event to a group, use a role topic (`forRole(r).publish`) or per-conn `conn.emit`. Put events meant for room broadcast in `shared.serverToClient`.
- **Clients cannot publish to topics.** `topics` are server-publish only. For client→others, send a request and have the handler validate, then `srv.publish(...)` / `forRole(r).publish(...)` / `room.broadcast(...)`.
- **Topics are typed by exact contract key only.** Parameterized topics (`'room:{id}'`) are not type-inferred — use a concrete key, or carry the id in the payload and filter client-side.
- **`conn.emit` / a `conn` reference is node-local.** To reach "user X wherever connected" across nodes, use `srv.toUser(uid).emit(...)` or `srv.toConn(id).emit(...)` — not a stored `conn`.
- **`srv.local.*` is sync + this-node-only; `srv.cluster.*` is async + cluster-wide.** Cluster reads need an adapter with presence (in-memory/redis have it) and an `identify` hook for `byUser`/`isOnline`/`toUser`. A `ConnDescriptor` is a connect-time snapshot, not a live `Conn` (no `lastPongAt`; seed extra fields in `onConnection`).
- **`toConn(id).request` is SHARED-only and single-target.** The caller has an id, not a role, so only `shared.serverToClient` requests are callable; `toUser` has **no** `request` (multi-device is ambiguous — pick a conn via `cluster.byUser` first). A missing/dead target rejects with `TIMEOUT`.
- **A server→client request needs `client.implement`.** Without a handler the client replies `NOT_FOUND`. Throw a `SuperLineError` in the handler for a typed failure.
- **Don't `toConn`/`toUser` a client in the *same tick* it connects.** The personal `c:{id}`/`u:{uid}` channel is subscribed fire-and-forget on connect; on Redis that `SUBSCRIBE` takes a moment to propagate, so a send issued in the same millisecond can miss. In real flows any prior `await` (a handler, an introspection call) closes the window — only synthetic "connect then immediately push" code hits it.
- **`cluster.*` / `isOnline` need a presence-capable adapter AND `identify`.** The in-memory and Redis adapters have presence; a custom pub/sub-only adapter makes `srv.cluster.*` throw. `byUser`/`isOnline`/`toUser` also need the `identify` hook set, or they see no user key.
- **Heartbeat liveness (`lastPongAt`) is node-local, not in the registry.** Cluster liveness is "node alive + conn present"; for per-socket freshness read `conn.lastPongAt` on the owning node. A crashed node's conns drop from cluster queries only after its alive-TTL expires.
- **The cluster event bus has LOCAL ECHO — you hear your own publish.** `server.subscribe` fires for a publish from ANY node *including this one* (delivered in-process, no Redis/WS round-trip). Self-exclude with `if (from === srv.nodeId) return`. (Contrast the old `serverToServer`, which excluded the sender — the bus does not.)
- **Don't conflate the bus with EVENTS.** `conn.emit` / `room.broadcast` / `toConn(id).emit` / `toUser(id).emit` are server-*chosen* pushes with no client opt-in and no server-side subscribe. The bus is **opt-in** pub/sub on a shared topic (`client.subscribe` to opt in; `server.subscribe` for cluster-wide server-side fan-in). Both exist; pick events when the server decides recipients, the bus when subscribers opt in.
- **Bus errors route to `opts.onError`.** A throwing listener or a bad inbound payload from another node goes to `onError(err, { kind: 'event', name })`; each listener is isolated — one throw never stops the others or the message pump.
- **JSON serializer loses rich types.** Default JSON turns `Date` into a string; use `z.coerce.date()` or configure `superjson` as the serializer on **both** ends (they must match).
- **The client is not awaitable.** It's a proxy; don't `await client` (only `await client.someRequest(...)`).
- **`subscribe().ready` rejects on denial/disconnect.** `await sub.ready` (or handle rejection) if you need to know the subscription was accepted.
- **A server `write` MERGES — it can't delete a key.** To remove a key server-side, `srv.store(ns).open(id).delete(path)`. On the CRDT store that delete is **surgical** and merges with a concurrent edit to another key; a full-document `set` (client or server) would clobber that concurrent edit, so prefer `update` to add/change, `delete(path)` to remove, and `set` only for a genuine whole-document replace.
- **A DELETED Resource reads as a silent empty snapshot — watch `deleted`, not the data.** `srv.store(ns).delete(id)` (or co-writer `delete(id)`) fans a wire `SDeleteFrame` (`'sdel'`) cluster-wide; every relay store relays it (`ServerStore.onDelete`) and subscribers re-read seeing `{}`. To distinguish "deleted" from "empty/never-existed", read `handle.deleted` (client `ResourceHandle`) / `useResource().deleted` (React) — the data snapshot alone can't tell you.
- **An in-process AI agent / bot should co-write through `srv.store(ns).open(id)`, not a loopback client.** The handle is server-authoritative (no ACL/grant, no transport), reads reactively (`subscribe` sees client edits), and deletes in-process atomically. `open` is also where a custom `origin` tags writes for Control Center attribution.
- **Store `data` isn't validated and the client handle is `unknown`.** Pass a type to `open<T>`/`useResource<T>` and assert it; don't expect server-side schema enforcement (that's what requests are for — ADR-0003).

## ❌ → ✅

```ts
// ❌ trusting the client's claimed role
authenticate: (h) => ({ role: claimedRole, ctx })         // a user can self-promote to admin
// ✅ derive/verify the role from the credential server-side
authenticate: (h) => { const u = verify(h.query.token); if (u.role !== h.query.role) throw new SuperLineError('FORBIDDEN'); return { role: u.role, ctx: u } }

// ❌ broadcasting a role-specific event to a (mixed) room
srv.room('lobby').broadcast('taskAssigned', data)          // type error — broadcast is shared-only
// ✅ shared event for rooms, or a role topic for role-specific fan-out
srv.room('lobby').broadcast('message', data)               // 'message' lives in shared.serverToClient
srv.forRole('agent').publish('taskAssigned', data)         // role topic

// ❌ client trying to publish to a topic
client.publish('prices', { … })                            // no such API; clients can't publish
// ✅ go through a server handler that authorizes, then fans out
await client.setPrice({ symbol, price })                   // handler -> srv.forRole('user').publish('prices', …)

// ❌ returning an error sentinel
return { error: 'nope' }
// ✅ throw a typed SuperLineError; the client promise rejects with the code
throw new SuperLineError('FORBIDDEN', 'not a member')

// ❌ stashing a conn to reach a user later (node-local; breaks across nodes, leaks on disconnect)
const conns = new Map(); onConnection: (conn, ctx) => conns.set(ctx.userId, conn)
later: conns.get(userId)?.emit('dm', msg)
// ✅ address the user by key — reaches every device on any node
identify: (conn) => conn.ctx.userId          // in server opts
later: srv.toUser(userId).emit('dm', msg)    // or srv.toConn(id).request(...) for a reply
```
