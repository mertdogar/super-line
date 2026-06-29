<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img alt="super-line" src="assets/logo-light.svg" width="340">
</picture>

### Strictly-typed realtime data bus — one contract for requests · events · subscriptions · synced state

[![License: MIT](https://img.shields.io/badge/license-MIT-22d3ee?style=flat-square&labelColor=1a1d24)](LICENSE)
[![Built with TypeScript](https://img.shields.io/badge/TypeScript-strict-22d3ee?style=flat-square&labelColor=1a1d24)](https://www.typescriptlang.org/)
[![Standard Schema](https://img.shields.io/badge/Standard%20Schema-ready-22d3ee?style=flat-square&labelColor=1a1d24)](https://standardschema.dev)
[![Docs](https://img.shields.io/badge/docs-super--line.dogar.biz-22d3ee?style=flat-square&labelColor=1a1d24)](https://super-line.dogar.biz/)

<br />

<img alt="super-line chat example" src="assets/chat.png" width="520">

</div>

<br />

**super-line** is a strictly-typed realtime data bus for TypeScript. You write **one contract**; the server implements it and the client calls it with full end-to-end type inference — no codegen. The contract is split by **direction** (`clientToServer` / `serverToClient`) and scoped by **role** — a `user` and an `agent` connect to the same server and each get their own typed surface, with a `shared` base in common. Requests, events, topics, rooms, synced state, and a cluster-wide event bus share one connection — over a **pluggable transport** (WebSocket by default; HTTP/SSE, libp2p and loopback also ship) — and everything fans out across processes through a pluggable **adapter** (in-memory for one node; Redis, RabbitMQ, ZeroMQ or libp2p for many).

> 📖 **Full documentation: [super-line.dogar.biz](https://super-line.dogar.biz/)** — guides, the complete API reference, and runnable examples.

## Contents

- [Features](#features)
- [Install](#install)
- [Quickstart](#quickstart)
- [Documentation](#documentation)
- [Examples](#examples)
- [Use with your AI agent](#use-with-your-ai-agent)
- [Comparison & FAQ](#comparison--faq)
- [Development](#development)
- [Packages](#packages)
- [Status](#status)

## Features

| | |
| --- | --- |
| 🧩 **Contract-first** | One schema is the SSOT; types flow to both ends with zero codegen. |
| 🎭 **Role-scoped** | One contract, many client roles (`user`, `agent`…) — each gets its own surface + `ctx`; cross-role calls get `NOT_FOUND`. |
| 🛡️ **Validator-agnostic** | Any [Standard Schema](https://standardschema.dev) validator — Zod, Valibot, ArkType. |
| ↔️ **Req/res** | Unary `await client.x()` with typed errors, timeout & `AbortSignal`. |
| 📣 **Events & rooms** | Server-pushed events; server-controlled room broadcasts. |
| 📡 **Topics** | Client-subscribed pub/sub streams, authorized server-side. |
| 🗄️ **Stores** | Permissioned, real-time JSON documents — a pluggable persisted-state primitive with per-client access rules, a reactive client handle, and a reactive in-process server co-writer (`srv.store(ns).open(id)`) that reads, merges, and surgically deletes. **Six backends:** LWW or CRDT × in-memory · durable (SQLite, libsql/Turso) · self-clustering (Postgres + Electric). |
| 🧹 **Cluster-wide delete** | `srv.store(ns).delete(id)` fans a deletion across every node (wire `sdel`); observe it via `ServerStore.onDelete`, the client `ResourceHandle.deleted` flag, and React `useResource().deleted`. |
| 🚌 **Cluster event bus** | `server.publish` / `server.subscribe` on a shared topic — cluster-wide pub/sub to server listeners (every node, local echo) and subscribed clients at once. |
| 📨 **Server→client req/res** | `await srv.toConn(id).request(...)` — ask a client and await a typed reply, across nodes. |
| 🛰️ **Presence & introspection** | `srv.local.*` (sync) + `srv.cluster.*` (counts, topology, `isOnline`) backed by a Redis registry. |
| 🩺 **Control Center** | `inspector: true` + `npx @super-line/control-center` — a shadcn webapp for live topology, contract, roles & ctx. |
| 🎯 **Targeted send** | `srv.toConn(id)` / `srv.toUser(uid)` emit or kick any connection on any node. |
| 🔌 **Composable** | Attaches to your `http.Server`; lifecycle hooks + middleware. |
| 🔁 **Resilient client** | Auto-reconnect, re-subscribe, in-flight reject, queue-and-flush. |
| 📈 **Scales** | Rooms, topics, the cluster event bus & presence fan out across nodes via an adapter (Redis included). |

## Install

```bash
pnpm add @super-line/core @super-line/server @super-line/client @super-line/transport-websocket zod

# other client↔server transports (WebSocket is the default above)
pnpm add @super-line/transport-http      # HTTP/SSE + long-poll
pnpm add @super-line/transport-libp2p    # libp2p / WebRTC (bring-your-own node)
pnpm add @super-line/transport-loopback  # in-memory, for tests

# server↔server fan-out adapters (only needed for >1 node)
pnpm add @super-line/adapter-redis     # central broker
pnpm add @super-line/adapter-rabbitmq  # AMQP broker
pnpm add @super-line/adapter-zeromq    # brokerless mesh / forwarder
pnpm add @super-line/adapter-libp2p    # decentralized gossip, broker-less

# stores — permissioned, real-time documents (pick a backend; pair with its client store)
pnpm add @super-line/store-memory       # LWW · in-memory · relay
pnpm add @super-line/store-sync         # CRDT · in-memory · relay
pnpm add @super-line/store-sqlite       # LWW · durable (better-sqlite3) · relay
pnpm add @super-line/store-sync-libsql  # CRDT · durable (libsql/Turso) · relay
pnpm add @super-line/store-pglite       # LWW · self-clustering (Postgres + Electric)
pnpm add @super-line/store-sync-pglite  # CRDT · self-clustering (Postgres + Electric)

pnpm add @super-line/react             # React hooks
```

Requirements: **Node 18+** (server). The WebSocket client uses the global `WebSocket` (browsers, and Node 22+); on older Node, pass `webSocketClientTransport({ url, WebSocket })`.

## Quickstart

### 1. Define the contract (shared)

```ts
import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const chat = defineContract({
  shared: {
    clientToServer: {
      join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
    },
    serverToClient: {
      // { payload } = push event; add `subscribe: true` to make it a client-subscribable topic
      message: { payload: z.object({ room: z.string(), text: z.string(), from: z.string() }) },
      presence: { payload: z.object({ room: z.string(), count: z.number() }), subscribe: true },
    },
  },
  roles: {
    user: {
      clientToServer: {
        send: { input: z.object({ room: z.string(), text: z.string() }), output: z.object({ id: z.string() }) },
      },
    },
  },
})
```

> One role here (`user`). Add more under `roles` — e.g. an `agent` with its own
> `clientToServer` verbs — and each client gets only its role's surface.

### 2. Server

```ts
import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { chat } from './contract'

const server = http.createServer() // or pass your Express/Fastify http.Server
const srv = createSuperLineServer(chat, {
  transports: [webSocketServerTransport({ server })],
  authenticate: (h) => {
    const name = h.query.name // the Handshake: { transport, headers, query, peer?, raw }
    if (!name) throw new Error('unauthorized') // throw -> 401 at the upgrade, no socket
    return { role: 'user' as const, ctx: { name } } // role + ctx; ctx in every handler
  },
})

srv.implement({
  shared: {
    join: async ({ room }, _ctx, conn) => {
      srv.room(room).add(conn)                                          // server-controlled membership
      srv.forRole('user').publish('presence', { room, count: srv.room(room).size })
      return { ok: true }
    },
  },
  user: {
    send: async ({ room, text }, ctx) => {
      srv.room(room).broadcast('message', { room, text, from: ctx.name }) // -> client.on('message')
      return { id: crypto.randomUUID() }
    },
  },
})

server.listen(3000)
```

### 3. Client

```ts
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { chat } from './contract'

const client = createSuperLineClient(chat, {
  transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
  role: 'user',                 // narrows the surface to shared ∪ user; sent to authenticate to verify
  params: { name: 'ada' },     // -> ?name=ada, read as h.query.name in authenticate
})

client.on('message', (m) => console.log(`${m.from}: ${m.text}`)) // typed
const sub = client.subscribe('presence', (p) => console.log(`${p.count} online`))

await client.join({ room: 'lobby' })
await client.send({ room: 'lobby', text: 'hi' }) // typed input/output; throws typed SuperLineError on failure

sub.unsubscribe()
client.close()
```

### Presence & cross-node reach (optional)

```ts
// server: identify connections so the cluster view + toUser can find them
createSuperLineServer(chat, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  identify: (conn) => conn.ctx.userId,
})

await srv.cluster.count()                 // total connections cluster-wide
await srv.isOnline('u42')                 // connected on any node?
srv.toUser('u42').emit('message', { ... }) // reach every device, any node

// ask a specific client and await its typed reply (across nodes):
const { ok } = await srv.toConn(connId).request('confirm', { q: 'Deploy now?' })
// client side: client.implement({ confirm: async ({ q }) => ({ ok: true }) })
```

See [Introspection & presence](https://super-line.dogar.biz/guide/introspection-and-presence) for the full surface.

## Documentation

The full docs live at **[super-line.dogar.biz](https://super-line.dogar.biz/)**:

- **Start here** — [Getting started](https://super-line.dogar.biz/guide/getting-started) · [The contract](https://super-line.dogar.biz/guide/the-contract) (roles, direction & the five flavors)
- **Guides** — [Requests](https://super-line.dogar.biz/guide/requests) · [Events & rooms](https://super-line.dogar.biz/guide/events-rooms) · [Topics](https://super-line.dogar.biz/guide/topics) · [Stores](https://super-line.dogar.biz/guide/store) · [Synced state (CRDT)](https://super-line.dogar.biz/guide/synced-state) · [Roles & auth](https://super-line.dogar.biz/guide/roles-auth) · [Middleware & lifecycle](https://super-line.dogar.biz/guide/middleware-lifecycle) · [Error handling](https://super-line.dogar.biz/guide/errors) · [Reconnection & delivery](https://super-line.dogar.biz/guide/reconnection-delivery) · [Serialization](https://super-line.dogar.biz/guide/serialization) · [Scaling & adapters](https://super-line.dogar.biz/guide/scaling-adapters) · [React](https://super-line.dogar.biz/guide/react) · [Testing](https://super-line.dogar.biz/guide/testing)
- **[API reference](https://super-line.dogar.biz/reference/)** — generated from source: every export, option, and type across the five packages.

## Examples

```bash
pnpm install

# Node end-to-end — a human (user) and an AI (agent) in one room:
pnpm --filter @super-line/example-chat start

# Browser React chat (Vite + WS server; open two tabs to chat live):
pnpm --filter @super-line/example-react-chat dev   # http://localhost:5173

# Slack-like chat (Vite + React 19 + shadcn) — channels, presence, typing, unread badges, with
# channels + history persisted to SQLite via store-sqlite (survives a server restart):
pnpm --filter @super-line/example-advanced-chat-app dev   # http://localhost:5173

# Collaborative canvas — synced JSON state over super-line, backed by a CRDT (open two tabs;
# server is a co-writer, with a live state + patch debug panel). Run one at a time:
pnpm --filter @super-line/example-synced-canvas-yjs dev         # Yjs        · http://localhost:5173
pnpm --filter @super-line/example-synced-canvas-automerge dev   # Automerge  · http://localhost:5173

# AI co-writer canvas — a server-side LLM agent co-edits the same CRDT board as you, via
# srv.store('scene').open(id) (reactive read + update + surgical delete). Needs an AI Gateway key:
pnpm --filter @super-line/example-ai-canvas dev   # http://localhost:5373 (set AI_GATEWAY_API_KEY)

# Hono (HTTP) + super-line (WS) on ONE port — uptime topic, shared todos, live cursors + a curl→WS bridge:
pnpm --filter @super-line/example-hono build && pnpm --filter @super-line/example-hono start   # http://localhost:3000

# One contract over THREE transports at once — WS + HTTP + libp2p, three clients, identical results:
pnpm --filter @super-line/example-transports start

# Token auth with roles (admin-only `secret`; user gets NOT_FOUND):
pnpm --filter @super-line/example-auth start

# Presence + targeted send + server→client requests across 2 nodes (no Docker):
pnpm --filter @super-line/example-presence start

# Cluster event bus in one process — server.publish + several server.subscribe listeners (local echo) + a client subscriber (no Redis):
pnpm --filter @super-line/example-event-bus start

# Real cluster: Redis + Caddy LB + 3 nodes + 6 clients, fan-out across processes (needs Docker):
cd examples/scaling && docker compose up

# Same cluster, decentralized: 3 nodes peer over libp2p — NO broker (needs Docker):
cd examples/scaling-libp2p && docker compose up

# Chat servers behind NAT: browsers reach them over WebRTC via one public circuit-relay-v2 relay (needs Docker):
cd examples/libp2p-nat && docker compose up

# Brokerless cluster: 3 nodes peer over a ZeroMQ mesh, NO broker (needs Docker):
cd examples/scaling-zeromq && docker compose up

# Cluster over a RabbitMQ broker: 3 nodes fan out via adapter-rabbitmq (needs Docker):
cd examples/scaling-rabbitmq && docker compose up

# "Delete your broker": the react-chat-cluster with Redis removed, on a ZeroMQ mesh (needs Docker):
cd examples/react-chat-cluster-zeromq && docker compose up --build

# Same react-chat-cluster on a RabbitMQ (AMQP) broker via adapter-rabbitmq (needs Docker):
cd examples/react-chat-cluster-rabbitmq && docker compose up --build

# React chat with a live transport dial — switch WebSocket / HTTP / libp2p at runtime (needs Docker):
cd examples/react-chat-transports && docker compose up --build

# Self-clustering store, NO adapter: central Postgres + per-node Electric→PGlite replica (needs Docker):
cd examples/store-pglite && docker compose up

# AI co-writer canvas on a self-clustering CRDT store (Postgres + Electric). Needs an AI Gateway key:
cd examples/ai-canvas-pglite && docker compose up   # set AI_GATEWAY_API_KEY

# Bus across a cluster: Redis + Caddy + 3 nodes converge a shared tally over the event bus (needs Docker):
cd examples/bus-cluster && docker compose up
```

More on each: [examples on the docs site](https://super-line.dogar.biz/examples/).

## Use with your AI agent

super-line ships an **agent guide** — the role + direction model, the interaction flavors, auth, scaling, testing, and common pitfalls — so your AI coding agent writes correct super-line code instead of guessing. It lives in [`skills/super-line`](skills/super-line): Claude Code gets the full skill (`SKILL.md` + `REFERENCE.md` + `RECIPES.md`, progressive disclosure); other agents get a condensed `AGENTS.md`.

```bash
# Claude Code (project-local; or ~/.claude/skills for all projects)
npx degit mertdogar/super-line/skills/super-line .claude/skills/super-line
```

For **Cursor, GitHub Copilot, and other agents** (one condensed file + where to put it), see the guide: **[Use with your AI agent](https://super-line.dogar.biz/guide/ai-agents)**.

## Comparison & FAQ

| | super-line | Socket.IO | tRPC | raw `ws` |
| --- | :---: | :---: | :---: | :---: |
| Typesafe contract | ✅ | ⚠️ types-only | ✅ | ❌ |
| Runtime validation | ✅ | ❌ | ✅ | ❌ |
| Per-role contracts | ✅ | ❌ | ❌ | ❌ |
| Req/res | ✅ | ack callbacks | ✅ | ❌ |
| Rooms | ✅ | ✅ | ❌ | ❌ |
| Topics (pub/sub) | ✅ | ⚠️ via rooms | subscriptions | ❌ |
| Cluster event bus | ✅ | ✅ | ❌ | ❌ |
| Server→client req/res | ✅ | ⚠️ ack-less | ❌ | ❌ |
| Presence / introspection | ✅ cluster-wide | ⚠️ rooms only | ❌ | ❌ |
| Multi-node | ✅ adapter | ✅ adapter | ❌ | ❌ |
| Zero codegen | ✅ | ✅ | ✅ | n/a |

**Why not Socket.IO?** Socket.IO splits its types into `ClientToServerEvents` / `ServerToClientEvents` / `InterServerEvents` interfaces you maintain by hand as **positional generics** (easy to swap), with no runtime validation. super-line keeps the same directional split but in **one shared object** (can't misorder, can't drift), validates inbound automatically, and adds something Socket.IO doesn't have: **per-role contracts**. More in the [comparison & FAQ](https://super-line.dogar.biz/guide/comparison-faq).

**Do I need Redis?** No — a single node uses the in-memory adapter. Add Redis only when you run more than one process.

**Does the client work in the browser?** Yes (and Node 22+). It uses the global `WebSocket`; pass `{ WebSocket }` on older runtimes.

## Development

```bash
pnpm test        # vitest (integration over real loopback; redis test auto-skips without Docker)
pnpm typecheck   # tsc across all packages
pnpm lint        # oxlint
pnpm build       # tsup, dual ESM + CJS + d.ts
pnpm docs:dev    # run the docs site locally (VitePress + TypeDoc)
```

## Packages

| Package | Purpose |
| --- | --- |
| [`@super-line/core`](packages/core) | `defineContract` (roles + direction), validation, wire protocol, the `Serializer` / `Adapter` / transport (`RawConn`·`ServerTransport`·`ClientTransport`·`Handshake`) / store (`ServerStore`·`ServerReplica`·`SDeleteFrame`) interfaces, `SuperLineError` |
| [`@super-line/server`](packages/server) | `createSuperLineServer` over any transport: role-keyed `implement`, rooms, topics, `forRole`, the cluster event bus (`publish`/`subscribe`), server→client requests (`toConn`/`toUser`), the in-process store co-writer (`srv.store(ns).open(id)`), local + cluster introspection, heartbeat, middleware, in-memory adapter |
| [`@super-line/client`](packages/client) | `createSuperLineClient` (role-scoped surface, reconnect, typed calls, `on` / `subscribe`, the store handle `store(ns).open(id)` with `set`/`update`/`delete`/`deleted`) |
| [`@super-line/react`](packages/react) | `createSuperLineHooks<C, Role>` → `useRequest` / `useEvent` / `useSubscription` / `useResource` |
| [`@super-line/control-center`](packages/control-center) | Debugging webapp (`npx`): live topology, contract, roles & per-conn ctx/state, transport/wire, `msg.*` live feed |
| **Transports** — client↔server wire ||
| [`@super-line/transport-websocket`](packages/transport-websocket) | Default WebSocket transport: HTTP upgrade, 401 rejection, inspector subprotocol, backpressure (`webSocketServerTransport`/`webSocketClientTransport`) |
| [`@super-line/transport-http`](packages/transport-http) | HTTP transport — SSE or long-poll downstream + POST upstream (`httpServerTransport`/`httpClientTransport`) |
| [`@super-line/transport-libp2p`](packages/transport-libp2p) | libp2p / WebRTC transport over a libp2p stream, bring-your-own node (`libp2pServerTransport`/`libp2pClientTransport`) |
| [`@super-line/transport-loopback`](packages/transport-loopback) | In-memory transport (no socket) — for tests (`createLoopbackTransport`) |
| **Adapters** — server↔server fan-out ||
| [`@super-line/adapter-redis`](packages/adapter-redis) | Redis Pub/Sub adapter for multi-node fan-out (central broker) |
| [`@super-line/adapter-rabbitmq`](packages/adapter-rabbitmq) | RabbitMQ (AMQP) adapter for multi-node fan-out |
| [`@super-line/adapter-zeromq`](packages/adapter-zeromq) | ZeroMQ adapter for multi-node fan-out — brokerless mesh or a lightweight forwarder, with gossip presence |
| [`@super-line/adapter-libp2p`](packages/adapter-libp2p) | Decentralized, broker-less libp2p (gossipsub) adapter — fan-out + presence, no broker |
| **Stores** — permissioned, real-time documents ||
| [`@super-line/store-memory`](packages/store-memory) | LWW · in-memory · relay — the default store pair (`memoryStoreServer`/`memoryStoreClient`) |
| [`@super-line/store-sync`](packages/store-sync) | CRDT (Yjs/super-store) · in-memory · relay (`syncStoreServer`/`syncStoreClient`) |
| [`@super-line/store-sqlite`](packages/store-sqlite) | LWW · durable (better-sqlite3 WAL) · relay (`sqliteStoreServer`; pair with `memoryStoreClient`) |
| [`@super-line/store-sync-libsql`](packages/store-sync-libsql) | CRDT · durable (libsql/Turso/sqld) · relay — async `libsqlSyncStore`; snapshot-per-resource, history-preserving rehydrate |
| [`@super-line/store-pglite`](packages/store-pglite) | LWW · self-clustering (central Postgres + per-node Electric→PGlite, **no adapter**) (`pgliteStoreServer`) |
| [`@super-line/store-sync-pglite`](packages/store-sync-pglite) | CRDT · self-clustering (Postgres op-log + Electric→PGlite, **no adapter**) (`syncPgliteStoreServer`) |

## Status

Pre-1.0. **Implemented:** role-scoped contracts, req/res, events, rooms, topics, Stores (LWW + CRDT across in-memory, durable SQLite / libsql-Turso, and self-clustering Postgres+Electric backends — with a reactive server-side co-writer and cluster-wide deletion fan-out), the cluster event bus (`server.publish`/`server.subscribe`), pluggable client↔server transports (WebSocket · HTTP/SSE · libp2p · loopback), auth, reconnect, middleware, in-memory + Redis + RabbitMQ + ZeroMQ + libp2p adapters, React hooks. **Not yet:** fire-and-forget client→server signals (every client→server is req/res today), mutable per-connection state, NATS adapter, wildcard/retained topics, session resume/replay, parameterized-topic type inference (topics are typed by exact contract key for now), backpressure safeguards.

## License

[MIT](LICENSE) © Mert
