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
| 🧩 **Collections** | Typed persisted state declared on the contract, validated on every write. Two kinds: relational **rows** — row-level security + live subsets, with [TanStack DB](https://tanstack.com/db) joins & optimistic mutations via the first-party adapter — and CRDT **documents** — a single doc opened by id whose concurrent edits merge (validate-before-commit; keep schemas presence-tolerant, ADR-0008). **Backends:** in-memory · SQLite/libSQL · self-clustering (Postgres + Electric). The typed successor to the retired Store family. |
| 🧹 **Cluster-wide delete** | Deleting a CRDT document fans out across every node (wire `cddel`); observe it via the client `collection(n).open(id)` `deleted` flag and React `useDoc().deleted` — until then a deleted doc reads as a silent empty snapshot. |
| 🚌 **Cluster event bus** | `server.publish` / `server.subscribe` on a shared topic — cluster-wide pub/sub to server listeners (every node, local echo) and subscribed clients at once. |
| 📨 **Server→client req/res** | `await srv.toConn(id).request(...)` — ask a client and await a typed reply, across nodes. |
| 🛰️ **Presence & introspection** | `srv.local.*` (sync) + `srv.cluster.*` (counts, topology, `isOnline`) backed by a Redis registry. |
| 🩺 **Control Center** | `plugins: [inspector()]` (from `@super-line/plugin-inspector`) + `npx @super-line/control-center` — a shadcn webapp for live topology, contract, roles & ctx. |
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

# collections — typed relational rows (pick a backend; client-side joins via TanStack DB)
pnpm add @super-line/collections-memory  # in-memory · relay
pnpm add @super-line/collections-sqlite  # durable (better-sqlite3) · relay
pnpm add @super-line/collections-pglite  # self-clustering (Postgres + Electric)
pnpm add @super-line/tanstack-db         # the TanStack DB adapter (joins, live queries)


pnpm add @super-line/react             # React hooks
```

Every `@super-line/*` package declares `@super-line/core` as a **peer**, so install it once — the first line above does. pnpm and npm 7+ add missing peers for you; Yarn does not.

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

See [Introspection & presence](https://super-line.dogar.biz/how-to/introspection-and-presence) for the full surface.

## Documentation

The full docs live at **[super-line.dogar.biz](https://super-line.dogar.biz/)**:

- **Learn** — [Your first typed round-trip](https://super-line.dogar.biz/tutorials/first-round-trip) · [Your first collection](https://super-line.dogar.biz/tutorials/first-collection) · [Go collaborative (CRDT)](https://super-line.dogar.biz/tutorials/go-collaborative) · [Assemble a chat backbone](https://super-line.dogar.biz/tutorials/chat-backbone) · [Put a live AI agent in the chat](https://super-line.dogar.biz/tutorials/ai-agent-chat) · [Co-edit a canvas with an agent](https://super-line.dogar.biz/tutorials/collaborative-canvas-with-agent)
- **How-to** — [Requests](https://super-line.dogar.biz/how-to/requests) · [Events & rooms](https://super-line.dogar.biz/how-to/events-rooms) · [Topics](https://super-line.dogar.biz/how-to/topics) · [Roles & auth](https://super-line.dogar.biz/how-to/roles-auth) · [Connection env](https://super-line.dogar.biz/how-to/connection-env) · [Middleware & lifecycle](https://super-line.dogar.biz/how-to/middleware-lifecycle) · [Errors](https://super-line.dogar.biz/how-to/errors) · [Serialization](https://super-line.dogar.biz/how-to/serialization) · [React](https://super-line.dogar.biz/how-to/react) · [Choose an adapter](https://super-line.dogar.biz/how-to/choose-an-adapter) · [Testing](https://super-line.dogar.biz/how-to/testing)
- **Plugins** — [Authentication](https://super-line.dogar.biz/how-to/plugin-auth) · [Chat backbone](https://super-line.dogar.biz/how-to/plugin-chat) · [Stream an agent's turn](https://super-line.dogar.biz/how-to/chat-streaming) · [Run an AI chat bot](https://super-line.dogar.biz/how-to/chat-bots) · [Channel resources](https://super-line.dogar.biz/how-to/chat-resources) · [Drive a channel from scripts](https://super-line.dogar.biz/how-to/chat-headless)
- **Collections** — [Overview](https://super-line.dogar.biz/collections/) · [Row collections](https://super-line.dogar.biz/collections/row-collections) · [CRDT documents](https://super-line.dogar.biz/collections/crdt-documents) · [Policies](https://super-line.dogar.biz/collections/policies) · [TanStack DB](https://super-line.dogar.biz/collections/tanstack-db) · [Backends](https://super-line.dogar.biz/collections/backends)
- **Concepts** — [Why super-line](https://super-line.dogar.biz/concepts/why-super-line) · [The contract](https://super-line.dogar.biz/concepts/the-contract) (roles, direction & the five flavors) · [Server-authoritative](https://super-line.dogar.biz/concepts/server-authoritative) · [Transports vs. adapters](https://super-line.dogar.biz/concepts/transports-and-adapters) · [Reconnection & delivery](https://super-line.dogar.biz/concepts/reconnection-delivery)
- **[API reference](https://super-line.dogar.biz/reference/)** — generated from source: every export, option, and type.

## Examples

```bash
pnpm install

# Node end-to-end — a human (user) and an AI (agent) in one room:
pnpm --filter @super-line/example-chat start

# Browser React chat (Vite + WS server; open two tabs to chat live):
pnpm --filter @super-line/example-react-chat dev   # http://localhost:5173

# Typed row collections end-to-end — RLS policies, live queries, TanStack DB on the client (one Node script):
pnpm --filter @super-line/example-collections start

# Slack-like chat (Vite + React 19 + shadcn) built on the plugin pair — real login via plugin-auth,
# channels/membership/messages from plugin-chat, plus a live LLM agent to talk to; persisted to SQLite:
pnpm --filter @super-line/example-collections-chat dev   # http://localhost:5173

# FLAGSHIP — a human and a Mastra agent co-edit a CRDT canvas from inside a chat channel
# (plugin-chat channel resources + streamed delegation cards), with three faces: web UI,
# terminal cockpit (TUI), and headless JSONL. Needs an AI Gateway key:
pnpm --filter @super-line/example-chat-supervisor dev   # http://localhost:5173 (set AI_GATEWAY_API_KEY)

# Channel-resource mechanics, headless: owned vs linked CRDT docs attached to a chat channel,
# acked writes, who's-open presence — one Node script, no UI, no LLM:
pnpm --filter @super-line/example-chat-resources start

# Collaborative canvas — synced JSON state over super-line, backed by a CRDT (open two tabs;
# server is a co-writer, with a live state + patch debug panel). Run one at a time:
pnpm --filter @super-line/example-synced-canvas-yjs dev         # Yjs        · http://localhost:5173
pnpm --filter @super-line/example-synced-canvas-automerge dev   # Automerge  · http://localhost:5173

# AI co-writer canvas — a server-side LLM agent co-edits the same CRDT board as you, via
# srv.collection('scene').open(id) (reactive read + update + surgical delete). Needs an AI Gateway key:
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

# The react-chat-cluster: Redis + 2 nodes + web + the Control Center in Docker (needs Docker):
cd examples/react-chat-cluster && docker compose up --build

# Same react-chat-cluster, decentralized: nodes peer over libp2p gossipsub — NO broker (needs Docker):
cd examples/react-chat-cluster-libp2p && docker compose up --build

# "Delete your broker": the react-chat-cluster with Redis removed, on a ZeroMQ mesh (needs Docker):
cd examples/react-chat-cluster-zeromq && docker compose up --build

# Same react-chat-cluster on a RabbitMQ (AMQP) broker via adapter-rabbitmq (needs Docker):
cd examples/react-chat-cluster-rabbitmq && docker compose up --build

# The auth + chat plugin stack over any wire — pick WebSocket / HTTP / libp2p per tab (needs Docker):
cd examples/react-chat-transports && docker compose up --build

# AI co-writer canvas on a self-clustering CRDT document collection (Postgres + Electric, NO adapter).
# Needs an AI Gateway key:
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

For **Cursor, GitHub Copilot, and other agents** (one condensed file + where to put it), see the guide: **[Use with your AI agent](https://super-line.dogar.biz/how-to/ai-agents)**.

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

**Why not Socket.IO?** Socket.IO splits its types into `ClientToServerEvents` / `ServerToClientEvents` / `InterServerEvents` interfaces you maintain by hand as **positional generics** (easy to swap), with no runtime validation. super-line keeps the same directional split but in **one shared object** (can't misorder, can't drift), validates inbound automatically, and adds something Socket.IO doesn't have: **per-role contracts**. More in the [comparison & FAQ](https://super-line.dogar.biz/concepts/comparison-faq).

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
| [`@super-line/core`](packages/core) | `defineContract` (roles + direction), validation, wire protocol, the `Serializer` / `Adapter` / transport (`RawConn`·`ServerTransport`·`ClientTransport`·`Handshake`) / collection (`CollectionStore`·`CrdtCollectionStore`) interfaces, `SuperLineError` |
| [`@super-line/server`](packages/server) | `createSuperLineServer` over any transport: role-keyed `implement`, rooms, topics, `forRole`, the cluster event bus (`publish`/`subscribe`), server→client requests (`toConn`/`toUser`), the in-process collection co-writer (`srv.collection(ns).open(id)`), local + cluster introspection, heartbeat, middleware, in-memory adapter |
| [`@super-line/client`](packages/client) | `createSuperLineClient` (role-scoped surface, reconnect, typed calls, `on` / `subscribe`, the collection handles — `collection(n).subscribe(query)` rows, `collection(n).open(id)` CRDT docs) |
| [`@super-line/react`](packages/react) | `createSuperLineHooks<C, Role>` → `useRequest` / `useEvent` / `useSubscription` / `useCollection` / `useDoc` |
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
| **Collections** — typed persisted state backends ||
| [`@super-line/collections-memory`](packages/collections-memory) | In-memory row-collection backend (`CollectionStore`) — the zero-dependency default |
| [`@super-line/collections-sqlite`](packages/collections-sqlite) | Durable SQLite row-collection backend — rows survive a restart, IR→SQL snapshot pushdown |
| [`@super-line/collections-pglite`](packages/collections-pglite) | Self-clustering row-collection backend — central Postgres + per-node Electric-synced PGlite replica, no adapter |
| [`@super-line/collections-crdt-memory`](packages/collections-crdt-memory) | In-memory CRDT document-collection backend (Yjs) — plus `crdtCollectionsClient`, the universal client engine |
| [`@super-line/collections-crdt-libsql`](packages/collections-crdt-libsql) | Durable CRDT document-collection backend — snapshot-per-doc to libSQL/Turso |
| [`@super-line/collections-crdt-pglite`](packages/collections-crdt-pglite) | Self-clustering CRDT document-collection backend — Yjs op-log in central Postgres, Electric→PGlite replica, validate-before-commit at ingress |
| [`@super-line/tanstack-db`](packages/tanstack-db) | [TanStack DB](https://tanstack.com/db) adapter — super-line collections as a sync source, with client-side live queries, joins & optimistic mutations |
| **Plugins** — paired contract + runtime bundles ||
| [`@super-line/plugin-inspector`](packages/plugin-inspector) | The Control Center inspector as a plugin — taps + a plugin-owned CC connection |
| [`@super-line/plugin-auth`](packages/plugin-auth) | First-party authentication — email/password, sessions, API keys, JWT, data-driven roles, all in typed collections |
| [`@super-line/plugin-chat`](packages/plugin-chat) | Chat backbone — channels, membership, messages, streamed AI turns & channel-linked CRDT resources (6 collections, 20 server-authoritative requests, hookable server-side); Mastra bridge on `/mastra`. Requires plugin-auth |

## Status

Pre-1.0. **Implemented:** role-scoped contracts, req/res, events, rooms, topics, Collections (typed rows with row-level security + CRDT document collections, across in-memory, durable SQLite/libSQL, and self-clustering Postgres+Electric backends — with the TanStack DB client engine, a server-side co-writer, and cluster-wide deletion fan-out), contract-fragment plugins (inspector · auth · chat), connection env (server-vended, client-visible per-connection state), the cluster event bus (`server.publish`/`server.subscribe`), pluggable client↔server transports (WebSocket · HTTP/SSE · libp2p · loopback), auth, reconnect, middleware, heartbeat + WebSocket backpressure policies, in-memory + Redis + RabbitMQ + ZeroMQ + libp2p adapters, React hooks. **Not yet:** fire-and-forget client→server signals (every client→server is req/res today), NATS adapter, wildcard/retained topics, session resume/replay, parameterized-topic type inference (topics are typed by exact contract key for now).

## License

[MIT](LICENSE) © Mert
