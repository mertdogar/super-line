<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img alt="super-line" src="assets/logo-light.svg" width="340">
</picture>

### End-to-end typesafe WebSockets — req/res, rooms & topics from one contract

[![License: MIT](https://img.shields.io/badge/license-MIT-22d3ee?style=flat-square&labelColor=1a1d24)](LICENSE)
[![Built with TypeScript](https://img.shields.io/badge/TypeScript-strict-22d3ee?style=flat-square&labelColor=1a1d24)](https://www.typescriptlang.org/)
[![Standard Schema](https://img.shields.io/badge/Standard%20Schema-ready-22d3ee?style=flat-square&labelColor=1a1d24)](https://standardschema.dev)
[![Zero codegen](https://img.shields.io/badge/codegen-zero-22d3ee?style=flat-square&labelColor=1a1d24)](#quickstart)

<br />

<img alt="super-line chat example" src="assets/chat.png" width="520">

</div>

<br />

**super-line** is a typesafe WebSocket library for TypeScript. You write **one contract**; the server implements it and the client calls it with full end-to-end type inference — no codegen. Three interaction patterns share a single connection, and rooms/topics fan out across processes through a pluggable adapter (in-memory for one node, Redis for many).

## Contents

- [Features](#features)
- [Install](#install)
- [Quickstart](#quickstart)
- [Concepts: the four patterns](#concepts-the-four-patterns)
- [React](#react)
- [Auth, middleware & validation](#auth-middleware--validation)
- [Reconnection & delivery](#reconnection--delivery)
- [Multi-node (Redis)](#multi-node-redis)
- [Examples](#examples)
- [Comparison & FAQ](#comparison--faq)
- [Development](#development)
- [Packages](#packages)
- [Status](#status)

## Features

| | |
| --- | --- |
| 🧩 **Contract-first** | One schema is the SSOT; types flow to both ends with zero codegen. |
| 🛡️ **Validator-agnostic** | Any [Standard Schema](https://standardschema.dev) validator — Zod, Valibot, ArkType. |
| ↔️ **Req/res** | Unary `await client.x()` with typed errors, timeout & `AbortSignal`. |
| 📣 **Events & rooms** | Server-pushed events; server-controlled room broadcasts. |
| 📡 **Topics** | Client-subscribed pub/sub streams, authorized server-side. |
| 🔌 **Composable** | Attaches to your `http.Server`; lifecycle hooks + middleware. |
| 🔁 **Resilient client** | Auto-reconnect, re-subscribe, in-flight reject, queue-and-flush. |
| 📈 **Scales** | Rooms & topics fan out across nodes via an adapter (Redis included). |

## Install

```bash
pnpm add @super-line/core @super-line/server @super-line/client zod
# optional
pnpm add @super-line/adapter-redis   # multi-node fan-out
pnpm add @super-line/react           # React hooks
```

Requirements: **Node 18+** (server). The client uses the global `WebSocket` (browsers, and Node 22+); on older Node, pass `{ WebSocket }`.

## Quickstart

### 1. Define the contract (shared)

```ts
import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const chat = defineContract({
  messages: {
    join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
    send: { input: z.object({ room: z.string(), text: z.string() }), output: z.object({ id: z.string() }) },
  },
  events: {
    message: z.object({ room: z.string(), text: z.string(), from: z.string() }),
  },
  topics: {
    presence: z.object({ room: z.string(), count: z.number() }),
  },
})
```

### 2. Server

```ts
import http from 'node:http'
import { createSocketServer } from '@super-line/server'
import { chat } from './contract'

const server = http.createServer() // or pass your Express/Fastify http.Server
const srv = createSocketServer(chat, {
  server,
  authenticate: (req) => {
    const name = new URL(req.url!, 'http://x').searchParams.get('name')
    if (!name) throw new Error('unauthorized') // throw -> 401 at the upgrade, no socket
    return { name } // becomes ctx in every handler
  },
})

srv.implement({
  join: async ({ room }, ctx, conn) => {
    srv.room(room).add(conn)                                   // server-controlled membership
    srv.publish('presence', { room, count: srv.room(room).size })
    return { ok: true }
  },
  send: async ({ room, text }, ctx) => {
    srv.room(room).broadcast('message', { room, text, from: ctx.name }) // -> client.on('message')
    return { id: crypto.randomUUID() }
  },
})

server.listen(3000)
```

### 3. Client

```ts
import { createClient } from '@super-line/client'
import { chat } from './contract'

const client = createClient(chat, {
  url: 'ws://localhost:3000',
  params: { name: 'ada' },     // -> ?name=ada, read in authenticate
  validate: 'inbound',          // optional: re-validate server->client payloads (great in dev)
})

client.on('message', (m) => console.log(`${m.from}: ${m.text}`)) // typed
const sub = client.subscribe('presence', (p) => console.log(`${p.count} online`))

await client.join({ room: 'lobby' })
await client.send({ room: 'lobby', text: 'hi' }) // typed input/output; throws typed SocketError on failure

sub.unsubscribe()
client.close()
```

<div align="center"><img alt="join screen" src="assets/join.png" width="240"></div>

## Concepts: the four patterns

One contract expresses four ways to move data — all fully typed:

<div align="center"><img alt="how the UI maps to the patterns" src="assets/annotated.png" width="820"></div>

| Pattern | Section | Direction | Who controls delivery | Use it for |
| --- | --- | --- | --- | --- |
| **req/res** | `messages` | client → server → client | one response per call | actions/queries: `send`, `join`, `getHistory` |
| **event** | `events` | server → client (push) | server picks recipients | room broadcasts, notifications, direct push |
| **topic** | `topics` | server → many clients | client subscribes (server authorizes) | live streams: prices, presence, feeds |
| **room** | (server API) | server → members | server-managed membership | grouping connections to broadcast events |

**Rules of thumb:** need a reply? `messages`. Pushing to clients *you* choose? `events` (often via `room.broadcast`). Clients opting into a stream? `topics`. A "room" is just a server-controlled channel whose `broadcast` delivers a contract `event` to its members.

## React

```tsx
import { useState } from 'react'
import { createClient } from '@super-line/client'
import { createSocketReact } from '@super-line/react'
import { chat } from './contract'

const { Provider, useRequest, useEvent, useSubscription } = createSocketReact<typeof chat>()

function Root() {
  const [client] = useState(() => createClient(chat, { url: 'ws://localhost:3000', params: { name: 'ada' } }))
  return <Provider client={client}><Room room="lobby" /></Provider>
}

function Room({ room }: { room: string }) {
  const { call: send, isLoading } = useRequest('send')
  const presence = useSubscription('presence')   // latest { room, count } | undefined
  const [log, setLog] = useState<string[]>([])
  useEvent('message', (m) => setLog((l) => [...l, `${m.from}: ${m.text}`]))
  // ... render log + an input that calls send({ room, text })
}
```

## Auth, middleware & validation

```ts
const srv = createSocketServer(chat, {
  server,
  // 1. authenticate once at the HTTP upgrade — throw to reject with 401 (no socket opened)
  authenticate: (req) => ({ user: verify(tokenFrom(req)) }),

  // 2. authorize each topic subscribe — return false or throw to deny
  authorizeSubscribe: (topic, ctx) => ctx.user.canRead(topic),

  // 3. middleware runs before req/subscribe handlers — call next() or throw to short-circuit
  use: [
    async (ctx, info, next) => { rateLimit(ctx.user, info.name); await next() },
    async (_ctx, info, next) => { const t = Date.now(); await next(); metric(info.name, Date.now() - t) },
  ],

  onConnection: (conn, ctx) => log('joined', ctx.user.id),
  onDisconnect: (conn, ctx) => cleanup(conn),
  onError: (err, info) => report(err, info),
})
```

**Validation.** The server **always** validates inbound messages (client input is untrusted). The client doesn't validate server→client payloads by default; opt in with `validate: 'inbound'` to catch contract drift between a deployed client and an updated server. Errors surface as a typed `SocketError`:

```ts
import { SocketError } from '@super-line/core'
try {
  await client.send({ room: 'lobby', text: 'hi' })
} catch (e) {
  if (e instanceof SocketError && e.code === 'UNAUTHORIZED') relogin()
}
// codes: BAD_REQUEST | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | TIMEOUT | VALIDATION | DISCONNECTED | INTERNAL
```

## Reconnection & delivery

The client is resilient by default:

- **Auto-reconnect** with exponential backoff + full jitter (configurable; `reconnect: false` to disable).
- **Topics re-subscribe automatically** on reconnect.
- **In-flight requests reject** with `DISCONNECTED` when the socket drops; calls made *while* reconnecting are **queued and flushed** once connected.

Delivery is **at-most-once**: messages sent while a client is offline are not replayed (correct for cursors, presence, live prices). Rooms are server-controlled, so after a reconnect the client re-runs its own join flow. Session resume/replay is not built yet — see [Status](#status).

## Multi-node (Redis)

The same code scales across processes — give every server a shared adapter:

```ts
import { createRedisAdapter } from '@super-line/adapter-redis'
const srv = createSocketServer(chat, { server, adapter: createRedisAdapter('redis://localhost:6379') })
```

Now `room.broadcast` and `srv.publish` fan out to clients connected to **any** node. Without an adapter, a per-server in-memory adapter is used (single node).

## Examples

```bash
pnpm install

# Node end-to-end (one server + two clients, prints the flow):
pnpm --filter @super-line/example-chat start

# Browser React chat (Vite + WS server; open two tabs to chat live):
pnpm --filter @super-line/example-react-chat dev   # http://localhost:5173

# Token auth (good token authorized, bad token rejected at the upgrade):
pnpm --filter @super-line/example-auth start

# Multi-node fan-out via Redis (needs Docker/Redis):
docker run --rm -p 6379:6379 redis:7
pnpm --filter @super-line/example-scaling start
```

## Comparison & FAQ

| | super-line | Socket.IO | tRPC | raw `ws` |
| --- | :---: | :---: | :---: | :---: |
| Typesafe contract | ✅ | ⚠️ types-only | ✅ | ❌ |
| Runtime validation | ✅ | ❌ | ✅ | ❌ |
| Req/res | ✅ | ack callbacks | ✅ | ❌ |
| Rooms | ✅ | ✅ | ❌ | ❌ |
| Topics (pub/sub) | ✅ | ⚠️ via rooms | subscriptions | ❌ |
| Multi-node | ✅ adapter | ✅ adapter | ❌ | ❌ |
| Zero codegen | ✅ | ✅ | ✅ | n/a |

**Why not Socket.IO?** Socket.IO is battle-tested but its types are bolted on (you maintain event-name interfaces by hand) and it has no runtime validation. super-line makes the contract the source of truth and validates inbound automatically.

**Why not tRPC?** tRPC is excellent for request/response (and SSE subscriptions), but doesn't model rooms or client-driven pub/sub topics. super-line is purpose-built for bidirectional realtime.

**Do I need Redis?** No — a single node uses the in-memory adapter. Add Redis only when you run more than one process.

**Does the client work in the browser?** Yes (and Node 22+). It uses the global `WebSocket`; pass `{ WebSocket }` on older runtimes.

**How are types shared?** Put the contract in a shared package/module both sides import. No build step, no generated files.

## Development

```bash
pnpm test        # vitest (integration over real loopback; redis test auto-skips without Docker)
pnpm typecheck   # tsc across all packages
pnpm lint        # oxlint
pnpm build       # tsup, dual ESM + CJS + d.ts
./scripts/screenshots.sh   # re-render the README mockups (headless Chrome)
```

## Packages

| Package | Purpose |
| --- | --- |
| [`@super-line/core`](packages/core) | `defineContract`, validation, wire protocol, `Serializer` / `Adapter` interfaces, `SocketError` |
| [`@super-line/server`](packages/server) | `createSocketServer` over `ws`, rooms, topics, middleware, in-memory adapter |
| [`@super-line/client`](packages/client) | `createClient` (reconnect, typed calls, `on` / `subscribe`) |
| [`@super-line/adapter-redis`](packages/adapter-redis) | Redis Pub/Sub adapter for multi-node fan-out |
| [`@super-line/react`](packages/react) | `createSocketReact` → `useRequest` / `useEvent` / `useSubscription` |

## Status

Pre-1.0. **Implemented:** req/res, events, rooms, topics, auth, reconnect, middleware, in-memory + Redis adapters, React hooks. **Not yet:** NATS adapter, wildcard/retained topics, session resume/replay, parameterized-topic type inference (topics are typed by exact contract key for now), backpressure safeguards.

## License

[MIT](LICENSE) © Mert
