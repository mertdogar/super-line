<!-- super-line agent guide (generic). Keep in sync with SKILL.md. -->
<!-- Full docs + API reference: https://mertdogar.github.io/super-line/ -->

# super-line

Typesafe WebSockets for TypeScript. **One contract is the single source of truth** — the server implements it, the client calls it, types flow end to end with no codegen. Use this guide when working with `@super-line/*` (`core` / `server` / `client` / `adapter-redis` / `react`). Not for socket.io, ws, or tRPC.

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
- **Server**: `createSuperLineServer(api, { authenticate })`, then `srv.implement({ shared, user, agent })`.
- **Client**: `createSuperLineClient(api, { url, role: 'user' })` → a typed proxy narrowed to that role's surface.

## The interaction flavors

| Flavor | Contract location | Who initiates | Use for |
|---|---|---|---|
| **request** | `clientToServer: { input, output }` | client (awaits one reply) | actions/queries |
| **event** | `serverToClient: { payload }` | server picks recipients | notifications, room broadcasts |
| **topic** | `serverToClient: { payload, subscribe: true }` | client subscribes (server authorizes) | live streams |
| **room** | server API (`srv.room`) | server controls membership | broadcast a shared event to a group |
| **server→client request** | `serverToClient: { input, output }` | server (awaits one reply) | asking a client: confirm, sync |
| **cluster event bus** | **shared** topic (`serverToClient: { payload, subscribe: true }`) | anyone (`server.publish`); servers `server.subscribe`, clients `client.subscribe` | cluster-wide pub/sub: gossip, fleet tallies + a client stream from one declaration |

## Quick reference

| Need | Do |
|---|---|
| Define contract | `defineContract({ shared, roles })` (any Standard Schema validator; Zod in examples) |
| Server | `const srv = createSuperLineServer(api, { server, authenticate }); srv.implement({ shared, user, agent })` |
| Authenticate | `authenticate: (req) => ({ role: 'user', ctx })` — `throw` to reject (401); verify the claimed role |
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
| Client call/listen/subscribe | `await client.send(input)` · `client.on('event', cb)` · `client.subscribe('feed', cb)` (await `.ready`) |
| Multi-node | pass `adapter: createRedisAdapter('redis://…')` to every server |
| React | `createSuperLineHooks<typeof api, 'user'>()` → `Provider` / `useRequest` / `useEvent` / `useSubscription` |

## Rules

- **ALWAYS** keep the contract in one shared module imported by both sides. Never hand-redeclare types.
- **ALWAYS** resolve the role server-side in `authenticate` and return `{ role, ctx }`. The client's `role` is a *claim* — verify it against the credential (`throw` to reject). Never trust it blindly.
- **ALWAYS** `throw new SuperLineError(code, msg, data?)` for expected failures — clients get the typed `code`. Unknown throws become `INTERNAL`.
- **ALWAYS** gate private topic subscriptions with `authorizeSubscribe(topic, ctx, conn)` (return `false`/throw to deny).
- **ALWAYS** treat delivery as **at-most-once**: offline clients miss messages. Make handlers idempotent; re-run join flows after reconnect.
- **ALWAYS** add `@super-line/adapter-redis` before running more than one server process, or rooms/topics/the cluster event bus only fan out within one node.
- **ALWAYS** self-exclude on the bus (`if (from === srv.nodeId) return`) when you don't want to react to your own publish — `server.subscribe` has **local echo**.
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

## ❌ → ✅

```ts
// ❌ trusting the client's claimed role
authenticate: (req) => ({ role: claimedRole, ctx })
// ✅ derive/verify the role from the credential server-side
authenticate: (req) => { const u = verify(token); if (u.role !== claimed) throw new SuperLineError('FORBIDDEN'); return { role: u.role, ctx: u } }

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

**Full guides + generated API reference:** <https://mertdogar.github.io/super-line/>
- The contract model: <https://mertdogar.github.io/super-line/guide/the-contract>
- API reference: <https://mertdogar.github.io/super-line/reference/>
- Recipes (auth, rooms, presence, scaling, testing): the guides under <https://mertdogar.github.io/super-line/>
