---
name: super-line
description: Use when building realtime features with super-line — TypeScript/JavaScript that imports from @super-line/core, @super-line/server, @super-line/client, @super-line/react, @super-line/adapter-redis (or -libp2p / -rabbitmq / -zeromq), a transport (@super-line/transport-websocket / -http / -libp2p / -loopback), a collection backend (@super-line/collections-memory / -sqlite / -pglite for typed rows; @super-line/collections-crdt-memory / -libsql / -pglite for CRDT documents), @super-line/tanstack-db, or @super-line/plugin-auth / @super-line/plugin-inspector — or when the user mentions super-line. Covers the one contract split by direction (clientToServer/serverToClient) and scoped by role (a shared base plus per-role surfaces); the interaction flavors (req/res requests, server-pushed events, client-subscribed topics, server-controlled rooms, the cluster event bus — a symmetric cluster-wide pub/sub on a shared topic via server.publish / server.subscribe / client.subscribe — and server→client requests where the server asks a client and awaits a typed reply via toConn.request / client.implement); collections — server-authoritative persisted state declared ON the contract and schema-validated, in two models: typed relational rows (queryable, deny-by-default RLS policies read→filter / write→bool, live client.collection(n).subscribe(query), TanStack DB joins/live-queries via @super-line/tanstack-db) and CRDT documents (whole-doc merge, validate-before-commit, opened by id via client.collection(n).open(id), server-side AI/bot co-writer via srv.collection(n).open(id)) across in-memory, durable (SQLite/libsql), and self-clustering (Postgres+Electric→PGlite) backends; first-party authentication via @super-line/plugin-auth (email/password, server-issued sessions, data-driven roles, API keys, JWT, revoke-and-kick, password reset) wired as a contract fragment; contract-fragment plugins (defineContract({ plugins }) merging collections/roles/surface into one materialized contract) and composition (defineSurface / mergeSurfaces to embed a library under one connection); upgrade-time auth that returns { role, ctx }, role enforcement (cross-role calls get NOT_FOUND), the typed SuperLineError model; connection introspection and presence (srv.local for this node, srv.cluster for the whole fleet — connection counts, topology, isOnline, byUser); targeted cross-node send and disconnect (srv.toConn(id) / srv.toUser(uid)); heartbeat liveness and zombie reaping; typed per-connection state (conn.data); backpressure; client reconnect and at-most-once delivery; multi-node scaling and the presence registry via an adapter; the Control Center live inspector (plugins: [inspector()]); testing over a real loopback server; and common pitfalls. Also reach for this skill when the user asks how to count or list connections, check who's online, broadcast or send to a specific user/connection across servers, fan a publish out cluster-wide to servers and clients at once, ask a connected client a question, track presence, add login / authentication / sessions / API keys / roles, store and sync permissioned rows, run live queries or joins over synced data, build a collaborative document, let a server-side AI agent or bot co-edit one, embed a super-line library into a host contract, or shape a typed WebSocket contract — even if they don't name super-line. Not for socket.io, ws, or tRPC.
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
| **collection (rows)** | `collections:` **on the contract** (`{ schema, key }`) | server-authoritative writes, fanned out **by filter** | client `subscribe(query)`s a live row-set | typed relational rows: messages, lists, feeds — RLS policies, TanStack joins |
| **CRDT document collection** | `collections:` on the contract **with a `crdt` key** | whole-doc merge, **validate-before-commit** | client `open(id)`s a doc | collaborative docs: scenes, canvases, agent/bot co-writers |

Decide: **Need a reply?** request. **Pushing to recipients *you* pick?** event (often via `room.broadcast`). **Clients opting into a stream?** topic. **Coordinating other server processes (and optionally clients) on a symmetric channel?** the **cluster event bus** — a shared topic with `server.publish` + `server.subscribe` + `client.subscribe`. **Persisted, queryable, per-client-permissioned rows that stay live?** a **collection** (typed rows, RLS policies). **A single collaboratively-edited document (merge concurrent edits)?** a **CRDT document collection**.

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
| Multi-node | pass an `adapter:` to every server — `createRedisAdapter('redis://…')` (or `-libp2p` / `-rabbitmq` / `-zeromq`, each has a `scaling-*` example). A `clustering:'self'` collection backend needs **none** (it owns its own sync) |
| Transport | server `transports: [webSocketServerTransport({ server })]` · client `transport: webSocketClientTransport({ url })`; swap in `httpServerTransport`/`httpClientTransport` (SSE/long-poll), `libp2p*Transport` (BYO node), or `loopback*Transport` (tests) |
| Control Center (debug) | `createSuperLineServer(api, { …, plugins: [inspector()] })` (from `@super-line/plugin-inspector`; `inspector({ redact: ['token'] })` to mask fields), then `npx @super-line/control-center` → cluster-wide live feed of `msg.*` + collection/CRDT traffic + topology |
| React | `const { Provider, useRequest, useEvent, useSubscription } = createSuperLineHooks<typeof api, 'user'>()` |
| **Collections** (typed rows) | Declare **on the contract** (`collections: { messages: { schema, key, references? } }`); server takes ONE backend (`memoryCollections()` · `sqliteCollections({file})` relay · `await pgliteCollections({pgUrl})` **self**) + row `policies` (deny-by-default `read`→IR filter / `write`→bool). Client `client.collection('messages').subscribe({filter,orderBy,limit})` → live row-set + `insert/update/delete/batch`; React `useCollection`. Joins/live-queries via `@super-line/tanstack-db` + TanStack DB. `srv.collection(n)` server co-write. See REFERENCE.md → Collections |
| **CRDT document collections** | Declare with a `crdt` key (no `key`): `collections: { scenes: { schema, crdt: { mode: 'document' } } }`. **Opened by id, not queried** (whole-doc merge). Server takes a SEPARATE `crdtCollections:` backend (`crdtMemoryCollections()` relay · `await crdtLibsqlCollections({url})` durable·relay · `await crdtPgliteCollections({pgUrl})` **self**) + guard-shaped `policies` (`read(principal,id,snapshot?)→bool` / `write(principal,id)→bool`, deny-by-default). **Validate-before-commit** at ingress — deltas ARE schema-checked; a reject → the client resyncs. Creation is server-only (`srv.collection(n).create(id,data)`). Client needs `crdtCollections: crdtCollectionsClient()`; `client.collection('scenes').open(id)` → DocHandle; React `useDoc`. See REFERENCE.md → CRDT document collections |
| **Auth** (`@super-line/plugin-auth`) | Contract: `plugins: [authContract()]` (adds the `guest` role + identity collections). Server: `const authKit = auth({ contract, collections: backend, jwt?, sendPasswordReset? })` then `authenticate: authKit.authenticate` + `identify: authKit.identify` + `plugins: [authKit.plugin]` — pass the **same** collection backend to `auth()` and the server. Client: `authClient({ authedRole: 'user', connect })` → `signIn`/`signUp`/`signOut` + `state`; React `createAuth(...)` → `<AuthProvider>` + `useAuth()`. Email/password · sessions · data-driven `roles[]` · API keys (`slp_`) · JWT · `authKit.revoke(userId)`. See REFERENCE.md → Authentication |
| **Chat** (`@super-line/plugin-chat`) | Chat backbone: channels (public/private), owner/member membership, messages (send/edit/delete). Contract: `plugins: [authContract(), chatContract()]` (REQUIRES plugin-auth; body host-parametrized via `chatContract({ content })`, default text). Server: `const chatKit = chat({ contract, hooks? })` + `plugins: [authKit.plugin, chatKit.plugin]` — every mutation is a hookable, server-authoritative request; collections are client-read-only (ADR-0010). Imperative kit `chatKit.channels/members/messages` (hooks fire, `initiator: 'server'`). Client: `chatClient(client, { userId })` (no TanStack/React dep, owns membership re-subscribe); React `createChatHooks()` → `useChannels`/`useMembers`/`useMessages`. AI agents = users provisioned via `authKit.users.create`+`apiKeys.create`. See REFERENCE.md → plugin-chat |
| **Contract plugins** | `defineContract({ plugins: [p] })` merges a plugin's `collections`/`roles`/`shared`/`policies` INTO the contract (plain intersection; dup keys throw). Fully-plugin-owned handler blocks drop to **optional** in `implement`. Author one with `defineContractPlugin(name, fragment)`. A paired plugin ships this contract half AND a runtime `SuperLinePlugin` for `createSuperLineServer({ plugins })`. See REFERENCE.md → Contract plugins |
| **Composition** | `mergeSurfaces(a, b)` merges two `defineSurface(...)` blocks per direction (dup key → compile error) to embed a library's surface under one role/connection; `defineSurface` preserves literal keys + `subscribe: true`. Put a role's `data:` schema **beside** the merge, not inside it. See REFERENCE.md → Composition |
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
- **ALWAYS** add a real adapter before running more than one server process — `@super-line/adapter-redis` (or `-libp2p` / `-rabbitmq` / `-zeromq`; Redis is the default, not the only choice) — otherwise rooms/topics/the cluster event bus/**relay** collection fan-out only happen within one node. **Exception:** a `clustering:'self'` collection backend (`collections-pglite`, `collections-crdt-pglite`) owns its own cross-node sync (central Postgres + Electric→PGlite) and needs **no** adapter.
- **ALWAYS** self-exclude on the bus when you don't want to react to your own publish — `server.subscribe` has **local echo**: `if (from === srv.nodeId) return`. The bus fires same-node listeners in-process (no Redis/WS hop); peers arrive via the adapter and are inbound-validated against the topic's payload schema.
- **PREFER** `events` (server picks recipients) over `topics` when the server decides who gets it; use `topics` only for client-initiated subscriptions.
- **PREFER** `srv.local.*` (sync, in-process) for hot-path reads; reach for `srv.cluster.*` only when you genuinely need the whole fleet. Cluster reads hit the adapter (Redis) and are **eventually consistent** — a snapshot, not a transaction. Don't poll them in a tight loop.
- **ALWAYS** seed cluster-descriptor fields (`identify`/`describeConn` inputs, `conn.data`) in `onConnection` — it runs just *before* the presence snapshot. Mutating `conn.data` later in a handler updates the in-process conn but **not** the already-written descriptor.
- **ALWAYS** remember collections are **on the contract and schema-validated** — the opposite of the retired off-contract store. LWW rows are validated on every write; CRDT docs are **validate-before-commit** (the ingress node merges the delta, snapshots to plaintext, validates against the contract schema, then commits + fans out only if valid). Access is **deny-by-default**: LWW `policies` (`read`→IR filter, `write`→bool) and CRDT guard policies (`read`/`write`→bool) both deny the op when omitted.
- **ALWAYS** keep CRDT-doc schemas **presence-tolerant** (`.catch`/`.optional` per field) — validate-before-commit runs on post-merge state, and a concurrent overwrite is a delete-then-insert that can transiently drop a field. A required scalar that goes momentarily absent → the write rejects → the writer wedges. Put aggregate/cross-field constraints (maxItems, sums) in requests, not the doc schema.
- **PREFER** a server-side co-writer (`srv.collection(n).open(id)` on a CRDT collection) over a loopback client for an in-process actor (AI agent, bot, validator): it reads reactively (`subscribe` sees clients' edits) and applies edits in-process. `update`/`set` MERGE keys; `delete(path)` is the surgical key removal that merges with a concurrent edit to a sibling key. Client-side CRDT writes are optimistic; a schema/policy rejection routes to `onStoreError` and the client hard-**resyncs** its replica to authoritative (no silent rollback).
- **PREFER** `@super-line/plugin-auth` over hand-rolling sessions when you need real login: it wires as a contract fragment (`authContract()`) + a server plugin (`authKit.plugin`), keeps all identity in collections, and hides super-line's guest→user reconnect. Because a connection's **role is frozen at connect**, login is a **reconnect, not an upgrade** — `signIn`/`signUp` tear down the guest socket and reconnect as the authed role. Pass the SAME `CollectionStore` to `auth({ collections })` and to the server.
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
- **`client.collection(n)` is polymorphic by contract.** A plain `{ schema, key }` collection returns a **query handle** (`subscribe(query)` → live row-set, `insert`/`update`/`delete(id)`/`batch`); a `crdt` collection returns an **open-by-id `DocHandle`** (`open(id)` → whole-doc merge). A CRDT collection also needs `crdtCollections: crdtCollectionsClient()` on the client or `open` throws `NOT_FOUND`. **Await `sub.ready` / `doc.ready`** before depending on live delivery (frames process concurrently).
- **A CRDT-doc `update`/`set` MERGES keys — `delete(path)` is the only removal.** `delete(path)` is **surgical** and merges with a concurrent edit to a sibling key; a whole-document `set` clobbers that concurrent edit. Prefer `update` to add/change, `delete(path)` to remove, `set` only for a genuine whole-document replace. (LWW row collections don't have this — you `insert`/`update`/`delete(id)` whole rows.)
- **A CRDT write can be REJECTED — and the client then resyncs.** The optimistic edit was applied locally; on a schema/policy reject the client re-opens and hard-**resets** to authoritative (the bad edit vanishes, `onStoreError` fires). Keep CRDT-doc schemas **presence-tolerant** (`.catch`/`.optional`) so a transient concurrent-overwrite gap doesn't trip validation and wedge the writer.
- **An in-process AI agent / bot should co-write through `srv.collection(n).open(id)` (a CRDT collection), not a loopback client.** The handle is server-authoritative (no policy check, no transport), reads reactively (`subscribe` sees client edits), and applies edits in-process. `open({ origin })` tags writes for Control Center attribution.

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
