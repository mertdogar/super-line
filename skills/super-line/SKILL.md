---
name: super-line
description: Use when building realtime features with super-line — TypeScript/JavaScript that imports from @super-line/core, @super-line/server, @super-line/client, @super-line/adapter-redis, or @super-line/react, or when the user mentions super-line. Covers the one contract split by direction (clientToServer/serverToClient) and scoped by role (a shared base plus per-role surfaces), the interaction flavors (req/res requests, server-pushed events, client-subscribed topics, server-controlled rooms, node-to-node serverToServer), upgrade-time auth that returns { role, ctx }, role enforcement (cross-role calls get NOT_FOUND), the typed SocketError model, client reconnect and at-most-once delivery, multi-node scaling via the Redis adapter, testing over a real loopback server, and common pitfalls. Not for socket.io, ws, or tRPC.
---

# super-line

Typesafe WebSockets for TypeScript. **One contract is the single source of truth** — the server implements it, the client calls it, types flow end to end with no codegen.

Human-facing docs (guides + full generated API reference): <https://mertdogar.github.io/super-line/>. This skill is the condensed, prescriptive version for agents.

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
  serverToServer: { /* node <-> node */ },   // optional, not role-scoped
})
```

- A **connection has a role**, decided at the upgrade from auth, fixed for its life. Each role gets a different typed surface *and* a different `ctx`.
- **Direction is the axis** (named keys, never positional generics). **Per entry:**
  - `clientToServer: { name: { input, output } }` → **request** (awaited, typed errors, timeout).
  - `serverToClient: { name: { payload } }` → **event** (server pushes to chosen recipients).
  - `serverToClient: { name: { payload, subscribe: true } }` → **topic** (client opts in via `subscribe`).
- **Server**: `createSocketServer(api, { authenticate })`, then `srv.implement({ shared, user, agent })`.
- **Client**: `createClient(api, { url, role: 'user' })` → a typed proxy narrowed to that role's surface.
- **No codegen.** Put the contract in a module both import. Never re-declare types on one side.

## The interaction flavors — pick the right one

| Flavor | Contract location | Direction | Who initiates | Use for |
|---|---|---|---|---|
| **request** | `clientToServer: { input, output }` | client → server → client (one reply) | client | actions/queries: `send`, `join`, `getHistory` |
| **event** | `serverToClient: { payload }` | server → client (push) | server picks recipients | room broadcasts, notifications, direct push |
| **topic** | `serverToClient: { payload, subscribe: true }` | server → many clients | **client** subscribes (server authorizes) | live streams: prices, presence, feeds |
| **room** | server API | server → members | **server** controls (`add`/`remove`) | grouping conns to broadcast a shared event |
| **server→client request** | `serverToClient: { input, output }` | server → client → server (one reply) | server | asking a client: `confirm`, `sync`, capability probe |
| **serverToServer** | `serverToServer: { schema }` | node → other nodes | server | cluster coordination: rebalance, cache-invalidate |

Decide: **Need a reply?** request. **Pushing to recipients *you* pick?** event (often via `room.broadcast`). **Clients opting into a stream?** topic. **Coordinating other server processes?** `serverToServer`.

## Quick reference

| Need | Do |
|---|---|
| Define contract | `defineContract({ shared, roles, serverToServer })` (schemas = any Standard Schema validator; Zod in examples) |
| Server | `const srv = createSocketServer(api, { server, authenticate }); srv.implement({ shared, user, agent })` |
| Authenticate | `authenticate: (req) => ({ role: 'user', ctx })` — `throw` to reject (401). Read the claimed role from `req` query and verify it. |
| Handler | `name: async (input, ctx, conn) => output` — `ctx`/`conn` narrowed to the block's role |
| Reply error | `throw new SocketError('FORBIDDEN', 'msg')` → client promise rejects with that typed code |
| Send to one conn | `conn.emit('event', data)` (scoped to the conn's role events) |
| Broadcast to a room | `srv.room('room:42').broadcast('event', data)` — **shared events only** (mixed-role room) |
| Publish a role topic | `srv.forRole('user').publish('feed', data)` — **server only** |
| Publish a shared topic | `srv.publish('announce', data)` — **server only** |
| Node → other nodes | `srv.emitServer('rebalance', data)` / `srv.onServer('rebalance', cb)` |
| Client | `const client = createClient(api, { url, role: 'user' })` |
| Client call | `await client.send(input, { timeoutMs?, signal? })` |
| Client listen | `client.on('event', (d) => …)` → returns unsubscribe |
| Client subscribe | `const sub = client.subscribe('feed', (d) => …); await sub.ready; sub.unsubscribe()` |
| Multi-node | pass `adapter: createRedisAdapter('redis://…')` to every server |
| React | `const { Provider, useRequest, useEvent, useSubscription } = createSocketReact<typeof api, 'user'>()` |
| Local introspection (sync) | `srv.local.connections` / `.rooms` / `.topics`; `srv.room('x').connections`; `conn.id`/`connectedAt`/`lastPongAt`; filter with plain JS |
| Cluster introspection (async) | `await srv.cluster.connections()` / `.count()` / `.byUser(uid)` / `.room(n)` / `.topology()`; `await srv.isOnline(uid)` — needs `identify` + presence adapter |
| Identify a conn for cluster | `identify: (conn) => conn.ctx.userId`, `describeConn: (conn) => ({ plan })` in server opts (ctx never auto-serialized) |
| Targeted cross-node send | `srv.toConn(id).emit('ev', d)` / `srv.toUser(uid).emit('ev', d)` (shared events); `srv.toConn(id).close()` / `srv.toUser(uid).disconnect()` |
| Ask a client (server→client req) | server: `await srv.toConn(id).request('confirm', input, { timeout?, signal? })`; client: `client.implement({ confirm: async (input) => output })` |
| Heartbeat / reaping | `heartbeat: { interval: 30_000, maxMissed: 2 }` (or `false`) in server opts; read `conn.lastPongAt` |
| Per-conn state | declare `data:` schema in a role block → `conn.data` typed per role, mutable, starts `{}` |
| Backpressure | `backpressure: { maxBufferedBytes, onExceed: 'close' | 'drop' }` in server opts |

Full signatures → **REFERENCE.md**. End-to-end best-practice patterns (roles, auth, presence, DMs, scaling, serverToServer, testing) → **RECIPES.md**.

## Rules

- **ALWAYS** keep the contract in one shared module imported by both sides. Never hand-redeclare types.
- **ALWAYS** resolve the role server-side in `authenticate` and return `{ role, ctx }`. The client's `role` option is a *claim*; verify it against the credential (`throw` to reject). Never trust the client's claimed role without checking.
- **ALWAYS** `throw new SocketError(code, msg, data?)` from handlers for expected failures — clients get the typed `code`. Unknown throws become `INTERNAL` (no internals leaked).
- **ALWAYS** gate topic subscriptions with `authorizeSubscribe(topic, ctx, conn)` when topics carry private data (return `false` or throw to deny).
- **ALWAYS** treat delivery as **at-most-once**: offline clients miss messages (no replay). Make handlers idempotent; re-run join flows after reconnect; don't assume in-flight requests survive a drop.
- **ALWAYS** add a real adapter (`@super-line/adapter-redis`) before running more than one server process — otherwise rooms/topics/serverToServer only fan out within one node.
- **PREFER** `events` (server picks recipients) over `topics` when the server decides who gets it; use `topics` only for client-initiated subscriptions.
- **NEVER** trust client input — the server validates inbound automatically, but don't bypass it; keep schemas tight.

## Pitfalls

- **A request belongs to exactly one role's surface (plus `shared`).** A cross-role or unknown method is rejected with **`NOT_FOUND`** at runtime — the client-side types already hide it, so this only bites if you bypass them.
- **Rooms are mixed-role; `broadcast` takes SHARED events only.** To push a role-specific event to a group, use a role topic (`forRole(r).publish`) or per-conn `conn.emit`. Put events meant for room broadcast in `shared.serverToClient`.
- **Clients cannot publish to topics.** `topics` are server-publish only. For client→others, send a request and have the handler validate, then `srv.publish(...)` / `forRole(r).publish(...)` / `room.broadcast(...)`.
- **Topics are typed by exact contract key only.** Parameterized topics (`'room:{id}'`) are not type-inferred — use a concrete key, or carry the id in the payload and filter client-side.
- **`conn.emit` / a `conn` reference is node-local.** To reach "user X wherever connected" across nodes, use `srv.toUser(uid).emit(...)` or `srv.toConn(id).emit(...)` — not a stored `conn`.
- **`srv.local.*` is sync + this-node-only; `srv.cluster.*` is async + cluster-wide.** Cluster reads need an adapter with presence (in-memory/redis have it) and an `identify` hook for `byUser`/`isOnline`/`toUser`. A `ConnDescriptor` is a connect-time snapshot, not a live `Conn` (no `lastPongAt`; seed extra fields in `onConnection`).
- **`toConn(id).request` is SHARED-only and single-target.** The caller has an id, not a role, so only `shared.serverToClient` requests are callable; `toUser` has **no** `request` (multi-device is ambiguous — pick a conn via `cluster.byUser` first). A missing/dead target rejects with `TIMEOUT`.
- **A server→client request needs `client.implement`.** Without a handler the client replies `NOT_FOUND`. Throw a `SocketError` in the handler for a typed failure.
- **`serverToServer` excludes the sender.** `emitServer` reaches *other* nodes only; on a single node it's a no-op.
- **JSON serializer loses rich types.** Default JSON turns `Date` into a string; use `z.coerce.date()` or configure `superjson` as the serializer on **both** ends (they must match).
- **The client is not awaitable.** It's a proxy; don't `await client` (only `await client.someRequest(...)`).
- **`subscribe().ready` rejects on denial/disconnect.** `await sub.ready` (or handle rejection) if you need to know the subscription was accepted.

## ❌ → ✅

```ts
// ❌ trusting the client's claimed role
authenticate: (req) => ({ role: claimedRole, ctx })       // a user can self-promote to admin
// ✅ derive/verify the role from the credential server-side
authenticate: (req) => { const u = verify(token); if (u.role !== claimed) throw new SocketError('FORBIDDEN'); return { role: u.role, ctx: u } }

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
// ✅ throw a typed SocketError; the client promise rejects with the code
throw new SocketError('FORBIDDEN', 'not a member')
```
