<!-- super-line agent guide (generic). Keep in sync with SKILL.md. -->
<!-- Full docs + API reference: https://super-line.dogar.biz/ -->

# super-line

A strictly-typed realtime data bus for TypeScript — one contract for every pattern on the wire (requests · events · subscriptions · synced state). **One contract is the single source of truth** — the server implements it, the client calls it, types flow end to end with no codegen. WebSocket is just the default transport (HTTP/SSE, libp2p, and loopback are swappable). Use this guide when working with `@super-line/*` (`core` / `server` / `client` / `react` · adapters `adapter-redis` / `-libp2p` / `-rabbitmq` / `-zeromq` · transports `transport-websocket` / `-http` / `-libp2p` / `-loopback` · collections `collections-{memory,sqlite,pglite}` (typed rows) / `collections-crdt-{memory,libsql,pglite}` (CRDT docs) · `tanstack-db` · plugins `plugin-auth` (auth) / `plugin-inspector` (Control Center)). Not for socket.io, ws, or tRPC.

## Mental model

There is exactly **one contract**, defined once and imported by **both** sides. It is split by **direction** and scoped by **role**:

```ts
// contract.ts — shared by server AND client
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
- **Direction is the axis** (named keys, never positional generics). Per `serverToClient` entry: `{ payload }` = **event** (server push); `{ payload, subscribe: true }` = **topic** (client opts in). A **shared** topic also serves as a **cluster event bus channel** (`server.publish`/`server.subscribe`/`client.subscribe`). `clientToServer` entries are `{ input, output }` **requests**.
- **Server**: `createSuperLineServer(api, { transports: [webSocketServerTransport({ server })], authenticate })`, then `srv.implement({ shared, user, agent })`. WS transport from `@super-line/transport-websocket`; alternatives: `transport-http` (SSE/long-poll), `transport-libp2p` (libp2p/WebRTC, BYO node), `transport-loopback` (in-memory, for tests) — see the Transports guide.
- **Client**: `createSuperLineClient(api, { transport: webSocketClientTransport({ url }), role: 'user' })` → a typed proxy narrowed to that role's surface.

## The interaction flavors

| Flavor | Contract location | Who initiates | Use for |
|---|---|---|---|
| **request** | `clientToServer: { input, output }` | client (awaits one reply) | actions/queries |
| **event** | `serverToClient: { payload }` | server picks recipients | notifications, room broadcasts |
| **topic** | `serverToClient: { payload, subscribe: true }` | client subscribes (server authorizes) | live streams |
| **room** | server API (`srv.room`) | server controls membership | broadcast a shared event to a group |
| **server→client request** | `serverToClient: { input, output }` | server (awaits one reply) | asking a client: confirm, sync |
| **cluster event bus** | **shared** topic (`serverToClient: { payload, subscribe: true }`) | anyone (`server.publish`); servers `server.subscribe`, clients `client.subscribe` | cluster-wide pub/sub: gossip, fleet tallies + a client stream from one declaration |
| **collection (rows)** | `collections:` on the contract | client `subscribe(query)`s a live row-set | typed relational rows: messages, lists, feeds (RLS policies, TanStack joins) |
| **CRDT document collection** | `collections:` w/ a `crdt` key | client `open(id)`s a doc | collaborative docs: scenes, canvases, agent/bot co-writers |

## Quick reference

| Need | Do |
|---|---|
| Define contract | `defineContract({ shared, roles })` (any Standard Schema validator; Zod in examples) |
| Server | `const srv = createSuperLineServer(api, { transports: [webSocketServerTransport({ server })], authenticate }); srv.implement({ shared, user, agent })` (`webSocketServerTransport` from `@super-line/transport-websocket`) |
| Authenticate | `authenticate: (h) => ({ role: 'user', ctx })` — `throw` to reject (401); read claimed role from the `Handshake` (`h.query.role`/`h.headers`) and verify it |
| Handler | `name: async (input, ctx, conn) => output` — `ctx`/`conn` narrowed to the block's role |
| Reply error | `throw new SuperLineError('FORBIDDEN', 'msg')` → client promise rejects with that code |
| Send to one conn | `conn.emit('event', data)` |
| Broadcast to a room | `srv.room('room:42').broadcast('event', data)` — **shared events only** |
| Publish a topic | `srv.forRole('user').publish('feed', data)` (role) / `srv.publish('announce', data)` (shared) — **server only** |
| Cluster event bus | `srv.publish('announce', data)` (any node) · `srv.subscribe('announce', (data, { from }) => …)` (server-side, cluster-wide, **local echo**, returns unsubscribe) · `client.subscribe('announce', cb)` (over WS) — one shared topic. Self-exclude: `if (from === srv.nodeId) return` |
| Introspection | `srv.local.connections/.rooms/.topics` (sync, this node) · `await srv.cluster.count()/.connections()/.byUser(uid)/.topology()` · `await srv.isOnline(uid)` (needs `identify` + presence adapter) |
| Targeted cross-node send | `srv.toConn(id).emit('ev', d)` / `srv.toUser(uid).emit('ev', d)` · `.close()` / `.disconnect()` to kick |
| Ask a client | `await srv.toConn(id).request('confirm', input, { timeout? })`; client: `client.implement({ confirm: async (input) => output })` |
| Heartbeat / per-conn state / backpressure | `heartbeat: { interval, maxMissed }` · `data:` schema in a role → typed `conn.data` · `backpressure: { maxBufferedBytes, onExceed }` |
| Connection env (ADR-0012) | `env:` schema in a role → server-vended, CLIENT-VISIBLE `conn.env`; seeded by `authenticate`'s `env`, updated live via `conn.setEnv(v)` / `srv.toConn(id).setEnv(v)` / `srv.toUser(uid).setEnv(v)`; client reads `client.env.current`/`.ready`/`.subscribe`, React `useEnv()`. Clients cannot write it |
| Client call/listen/subscribe | `await client.send(input)` · `client.on('event', cb)` · `client.subscribe('feed', cb)` (await `.ready`) |
| Multi-node | pass an `adapter:` to every server — `createRedisAdapter('redis://…')` (or `-libp2p` / `-rabbitmq` / `-zeromq`, each with a `scaling-*` example). A `clustering:'self'` collection backend needs **none** |
| Transport | server `transports: [webSocketServerTransport({ server })]` · client `transport: webSocketClientTransport({ url })`; swap in `http*Transport` (SSE/long-poll), `libp2p*Transport` (BYO node), or `loopback*Transport` (tests) |
| Control Center | `createSuperLineServer(api, { …, plugins: [inspector()] })` (from `@super-line/plugin-inspector`; `inspector({ redact: ['token'] })` to mask fields), then `npx @super-line/control-center` → cluster-wide live feed of `msg.*` + collection/CRDT traffic + topology |
| React | `createSuperLineHooks<typeof api, 'user'>()` → `Provider` / `useRequest` / `useEvent` / `useSubscription` / `useCollection` (rows) / `useDoc` (CRDT doc) |
| Collections (rows) | Declare on the contract (`collections: { messages: { schema, key, references? } }`). Server: ONE backend `collections: memoryCollections()` (· `sqliteCollections({file, collections})` relay · `await pgliteCollections({pgUrl, collections})` **self**) + deny-by-default `policies` (`read`→IR filter / `write`→bool). Client `client.collection('messages').subscribe({filter,orderBy,limit})` → rows + `insert`/`update`/`delete(id)`/`batch`. Joins/live-queries via `@super-line/tanstack-db`. `srv.collection(n)` server co-write |
| CRDT doc collections | `collections: { scenes: { schema, crdt: {…} } }` (no `key`). Server: SEPARATE `crdtCollections: crdtMemoryCollections()` (· `await crdtLibsqlCollections({url})` · `await crdtPgliteCollections({pgUrl})` **self**) + guard `policies` (`read`/`write`→bool). Validate-before-commit; creation server-only (`srv.collection(n).create(id,data)`). Client needs `crdtCollections: crdtCollectionsClient()`; `client.collection('scenes').open(id)` → DocHandle; server co-writer `srv.collection(n).open(id)` |
| Auth (`plugin-auth`) | Contract `plugins: [authContract()]`; server `const authKit = auth({ contract, collections, jwt? })` → `authenticate: authKit.authenticate` + `identify: authKit.identify` + `plugins: [authKit.plugin]` (SAME collection backend); client `authClient({ authedRole, connect })` → `signIn`/`signUp`/`signOut` + `state`; React `createAuth(...)` → `<AuthProvider>` + `useAuth()`. Sessions · data-driven `roles[]` · API keys · JWT · `authKit.revoke(uid)` |
| Contract plugins / composition | `defineContract({ plugins: [p] })` merges a plugin's collections/roles/surface/policies in (dup keys throw; fully-owned handler blocks → optional); author via `defineContractPlugin(name, fragment)`. `mergeSurfaces(defineSurface(a), defineSurface(b))` embeds a library's surface under one role (`data:` goes beside the merge) |

## Rules

- **ALWAYS** keep the contract in one shared module imported by both sides. Never hand-redeclare types.
- **ALWAYS** resolve the role server-side in `authenticate` and return `{ role, ctx }`. The client's `role` is a *claim* — verify it against the credential (`throw` to reject). Never trust it blindly.
- **ALWAYS** `throw new SuperLineError(code, msg, data?)` for expected failures — clients get the typed `code`. Unknown throws become `INTERNAL`.
- **ALWAYS** gate private topic subscriptions with `authorizeSubscribe(topic, ctx, conn)` (return `false`/throw to deny).
- **ALWAYS** treat delivery as **at-most-once**: offline clients miss messages. Make handlers idempotent; re-run join flows after reconnect.
- **ALWAYS** add an adapter before running more than one server process — `@super-line/adapter-redis` (or `-libp2p` / `-rabbitmq` / `-zeromq`; Redis isn't the only choice) — or rooms/topics/the cluster event bus/**relay** collection fan-out only happen within one node. A `clustering:'self'` collection backend (`collections-pglite`, `collections-crdt-pglite`) owns its own sync and needs **no** adapter.
- **ALWAYS** self-exclude on the bus (`if (from === srv.nodeId) return`) when you don't want to react to your own publish — `server.subscribe` has **local echo**.
- **ALWAYS** remember collections are **on the contract and schema-validated** (the opposite of the retired off-contract store): LWW rows validate on every write; CRDT docs are **validate-before-commit**. Access is **deny-by-default** — omit a `policy` and that op is server-only. For an in-process actor (AI agent, bot), co-write a CRDT collection via `srv.collection(n).open(id)` (reactive reads + `delete(path)`), not a loopback client. Keep CRDT-doc schemas presence-tolerant (`.catch`/`.optional`) or a concurrent-overwrite gap wedges the writer.
- **PREFER** `@super-line/plugin-auth` for real login (email/password · sessions · roles · API keys · JWT): wire `plugins: [authContract()]` on the contract, `authenticate`/`identify`/`plugins: [authKit.plugin]` on the server (SAME collection backend passed to `auth()`), `authClient`/`createAuth` on the client. Role is frozen at connect, so login is a **reconnect**, not an upgrade.
- **NEVER** trust client input — the server validates inbound automatically; keep schemas tight, don't bypass.

## Pitfalls

- **Cross-role / unknown methods are rejected with `NOT_FOUND`** at runtime (types hide them; this bites only if you bypass the typed client).
- **Rooms are mixed-role; `broadcast` takes SHARED events only.** Put room-broadcast events in `shared.serverToClient`; for role-specific fan-out use a topic or `conn.emit`.
- **Clients cannot publish to topics.** For client→others, send a request and have the handler publish.
- **Topics are typed by exact key.** Parameterized names (`'room:{id}'`) aren't inferred — use a concrete key + carry the id in the payload.
- **`conn.emit` / a stored `conn` is node-local.** To reach a user across nodes, use `srv.toUser(uid).emit(...)` / `srv.toConn(id).emit(...)`.
- **`srv.local.*` is sync/this-node; `srv.cluster.*` is async/cluster-wide** (needs a presence adapter + `identify`). A `ConnDescriptor` is a connect-time snapshot, not a live `Conn`.
- **`toConn(id).request` is shared-only + single-target** (missing target → `TIMEOUT`); `toUser` has no `request`. The client must `client.implement` the handler or it replies `NOT_FOUND`.
- **Seed `identify`/`describeConn`/`conn.data` in `onConnection`** — it runs before the presence snapshot; mutating `conn.data` later won't update the already-written cluster descriptor. Prefer sync `srv.local.*` on hot paths (`srv.cluster.*` hits the adapter and is eventually consistent).
- **The cluster event bus has LOCAL ECHO — you hear your own publish.** `server.subscribe` fires for a publish from ANY node *including this one* (in-process, no Redis/WS hop). Self-exclude with `if (from === srv.nodeId) return`. Peers arrive via the adapter, inbound-validated against the topic's payload; a throwing listener / bad inbound payload routes to `onError(err, { kind: 'event', name })`, listeners isolated.
- **Don't conflate the bus with EVENTS.** `conn.emit` / `room.broadcast` / `toConn(id).emit` / `toUser(id).emit` are server-*chosen* pushes (no client opt-in, no server-side subscribe). The bus is **opt-in** pub/sub on a shared topic. Both exist — events when the server picks recipients, the bus when subscribers opt in.
- **JSON loses `Date`.** Use `z.coerce.date()` or a `superjson` serializer on **both** ends.
- **The client is a proxy, not awaitable** — `await client.someRequest(...)`, never `await client`.
- **`client.collection(n)` is polymorphic by contract.** A `{ schema, key }` collection → query handle (`subscribe(query)` / `insert` / `update` / `delete(id)` / `batch`); a `crdt` collection → open-by-id `DocHandle` (needs `crdtCollections: crdtCollectionsClient()` or `open` throws `NOT_FOUND`). Await `sub.ready` / `doc.ready` before depending on live delivery.
- **A CRDT-doc `update`/`set` MERGES keys; `delete(path)` is the only removal** (surgical — merges with a sibling-key edit; a whole-doc `set` clobbers). A CRDT write can be **rejected** → the client hard-resets its replica to authoritative (`onStoreError` fires). Keep CRDT-doc schemas presence-tolerant (`.catch`/`.optional`) so a transient concurrent-overwrite gap doesn't wedge the writer.
- **`env` is server-vended, client-visible, and read-only to the client (ADR-0012).** Only `conn.setEnv`/`srv.toConn(id).setEnv`/`srv.toUser(uid).setEnv` push a value (full-value replace); there's no client-side `set`. The Control Center masks `env` values by default (`•••`) — the opposite of `ctx`/`data`'s deny-list `redact` — allow-list safe keys via `inspector({ revealEnvKeys: [...] })`.

## ❌ → ✅

```ts
// ❌ trusting the client's claimed role
authenticate: (h) => ({ role: claimedRole, ctx })
// ✅ derive/verify the role from the credential server-side
authenticate: (h) => { const u = verify(h.query.token); if (u.role !== h.query.role) throw new SuperLineError('FORBIDDEN'); return { role: u.role, ctx: u } }

// ❌ broadcasting a role-specific event to a (mixed) room
srv.room('lobby').broadcast('taskAssigned', data)       // type error — broadcast is shared-only
// ✅ shared event for rooms; role topic for role-specific fan-out
srv.room('lobby').broadcast('message', data)            // 'message' is in shared.serverToClient
srv.forRole('agent').publish('taskAssigned', data)

// ❌ returning an error sentinel
return { error: 'nope' }
// ✅ throw a typed SuperLineError; the client promise rejects with the code
throw new SuperLineError('FORBIDDEN', 'not a member')
```

---

**Full guides + generated API reference:** <https://super-line.dogar.biz/>
- The contract model: <https://super-line.dogar.biz/concepts/the-contract>
- API reference: <https://super-line.dogar.biz/reference/>
- Recipes (auth, rooms, presence, scaling, testing): the guides under <https://super-line.dogar.biz/>
