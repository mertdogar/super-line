---
name: super-line
description: Use when building realtime features with super-line — TypeScript/JavaScript that imports from @super-line/core, @super-line/server, @super-line/client, @super-line/adapter-redis, or @super-line/react, or when the user mentions super-line. Covers the contract-first model and the four patterns (req/res messages, server-pushed events, server-controlled rooms, client-subscribed topics), upgrade-time auth + authorizeSubscribe + middleware, the typed SocketError model, client reconnect and at-most-once delivery, multi-node scaling via the Redis adapter, testing over a real loopback server, and common pitfalls. Not for socket.io, ws, or tRPC.
---

# super-line

Typesafe WebSockets for TypeScript. **One contract is the single source of truth** — the server implements it, the client calls it, types flow end to end with no codegen.

## Mental model — read this first

There is exactly **one contract**, defined once and imported by **both** sides:

```ts
// contract.ts — shared by server AND client (a shared module/package)
import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const api = defineContract({
  messages: { /* req/res */ },   // client calls, server replies once
  events:   { /* server push */ }, // server -> chosen clients (rooms broadcast these)
  topics:   { /* pub/sub */ },     // client subscribes, server publishes
})
```

- **Server**: `createSocketServer(api, opts)` then `srv.implement({ ...handlers })`. Bound to the contract at creation.
- **Client**: `createClient(api, opts)` → a typed proxy: `await client.someMessage(input)`, `client.on(event, cb)`, `client.subscribe(topic, cb)`.
- **No codegen, no generated files.** Put the contract in a module both import. Never re-declare types on one side.

## The four patterns — pick the right one

| Pattern | Contract section | Direction | Membership | Use for |
|---|---|---|---|---|
| **req/res** | `messages` | client → server → client (one reply) | — | actions/queries: `send`, `join`, `getHistory` |
| **event** | `events` | server → client (push) | server chooses recipients | room broadcasts, notifications, direct push |
| **topic** | `topics` | server → many clients | **client** subscribes (server authorizes) | live streams: prices, presence, feeds |
| **room** | server API | server → members | **server** controls (`add`/`remove`) | grouping conns to broadcast events |

Decide: **Need a reply?** `messages`. **Pushing to recipients *you* pick?** `events` (usually via `room.broadcast`). **Clients opting into a stream?** `topics`. A *room* is just a server-controlled channel whose `broadcast` delivers a contract `event` to its members.

## Quick reference

| Need | Do |
|---|---|
| Define contract | `defineContract({ messages, events, topics })` (schemas = any Standard Schema validator; Zod in examples) |
| Server | `const srv = createSocketServer(api, { server, authenticate }); srv.implement({...})` |
| Handler | `name: async (input, ctx, conn) => output` — `input`/`output` validated/typed by the contract |
| Reply error | `throw new SocketError('FORBIDDEN', 'msg')` → client promise rejects with that typed code |
| Send to one conn | `conn.emit('event', data)` |
| Broadcast to a room | `srv.room('room:42').broadcast('event', data)` (members added via `srv.room(...).add(conn)`) |
| Publish a topic | `srv.publish('prices', data)` — **server only** |
| Client call | `await client.send(input, { timeoutMs?, signal? })` |
| Client listen | `client.on('event', (d) => ...)` → returns unsubscribe |
| Client subscribe | `const sub = client.subscribe('prices', (d) => ...); await sub.ready; sub.unsubscribe()` |
| Multi-node | pass `adapter: createRedisAdapter('redis://…')` to every server |
| React | `const { Provider, useRequest, useEvent, useSubscription } = createSocketReact<typeof api>()` |

Full signatures → **REFERENCE.md**. End-to-end best-practice patterns (auth, presence, DMs, scaling, testing) → **RECIPES.md**.

## Rules

- **ALWAYS** keep the contract in one shared module imported by both sides. Never hand-redeclare event/message types.
- **ALWAYS** authenticate at the upgrade with `authenticate(req)`; `throw` to reject (returns 401, no socket opened). The returned value is `ctx` in every handler.
- **ALWAYS** `throw new SocketError(code, msg, data?)` from handlers for expected failures — clients get the typed `code`. Unknown throws become `INTERNAL` (no internals leaked).
- **ALWAYS** gate topic subscriptions with `authorizeSubscribe(topic, ctx, conn)` when topics carry private data (return `false` or throw to deny).
- **ALWAYS** treat delivery as **at-most-once**: offline clients miss messages (no replay). Make handlers idempotent; re-run join flows after reconnect; don't assume in-flight requests survive a drop.
- **ALWAYS** add a real adapter (`@super-line/adapter-redis`) before running more than one server process — otherwise rooms/topics only fan out within one node.
- **PREFER** `events` (server picks recipients) over `topics` when the server decides who gets it; use `topics` only for client-initiated subscriptions.
- **NEVER** trust client input — the server validates inbound automatically, but don't bypass it; keep schemas tight.

## Pitfalls

- **Clients cannot publish to topics.** `topics` are server-publish only. For client→others, send a `message` and have the handler validate, then `srv.publish(...)` / `room.broadcast(...)`.
- **Topics are typed by exact contract key only.** Parameterized topics (`'room:{id}'`) are not yet type-inferred — use a concrete key, or carry the id in the payload and filter client-side.
- **`conn.emit` / a `conn` reference is node-local.** To reach "user X wherever connected" across nodes, broadcast to a per-user channel (e.g. a `user:{id}` room/topic) — not a stored `conn`.
- **JSON serializer loses rich types.** Default JSON turns `Date` into a string; use `z.coerce.date()` or configure `superjson` as the serializer on **both** ends (they must match).
- **The client is not awaitable.** It's a proxy; don't `await client` (only `await client.someMessage(...)`).
- **`subscribe().ready` rejects on denial/disconnect.** `await sub.ready` (or handle rejection) if you need to know the subscription was accepted.

## ❌ → ✅

```ts
// ❌ client trying to publish to a topic
client.publish('prices', { ... })                 // no such API; clients can't publish
// ✅ go through a server handler that authorizes, then fans out
await client.setPrice({ symbol, price })          // handler -> srv.publish('prices', ...)

// ❌ redeclaring types on the client
type Message = { text: string }                   // drifts from the server
// ✅ import the one contract; types are inferred
import { api } from './contract'; const c = createClient(api, { url })

// ❌ returning an error sentinel
return { error: 'nope' }
// ✅ throw a typed SocketError; the client promise rejects with the code
throw new SocketError('FORBIDDEN', 'not a member')
```
