<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img alt="super-line" src="assets/logo-light.svg" width="340">
</picture>

### End-to-end typesafe WebSockets — role-scoped contracts, req/res, rooms & topics

[![License: MIT](https://img.shields.io/badge/license-MIT-22d3ee?style=flat-square&labelColor=1a1d24)](LICENSE)
[![Built with TypeScript](https://img.shields.io/badge/TypeScript-strict-22d3ee?style=flat-square&labelColor=1a1d24)](https://www.typescriptlang.org/)
[![Standard Schema](https://img.shields.io/badge/Standard%20Schema-ready-22d3ee?style=flat-square&labelColor=1a1d24)](https://standardschema.dev)
[![Docs](https://img.shields.io/badge/docs-mertdogar.github.io-22d3ee?style=flat-square&labelColor=1a1d24)](https://mertdogar.github.io/super-line/)

<br />

<img alt="super-line chat example" src="assets/chat.png" width="520">

</div>

<br />

**super-line** is a typesafe WebSocket library for TypeScript. You write **one contract**; the server implements it and the client calls it with full end-to-end type inference — no codegen. The contract is split by **direction** (`clientToServer` / `serverToClient`) and scoped by **role** — a `user` and an `agent` connect to the same server and each get their own typed surface, with a `shared` base in common. Requests, events, topics, rooms, and node-to-node messaging share one connection, and everything fans out across processes through a pluggable adapter (in-memory for one node, Redis for many).

> 📖 **Full documentation: [mertdogar.github.io/super-line](https://mertdogar.github.io/super-line/)** — guides, the complete API reference, and runnable examples.

## Contents

- [Features](#features)
- [Install](#install)
- [Quickstart](#quickstart)
- [Documentation](#documentation)
- [Examples](#examples)
- [Agent skill](#agent-skill)
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
| 🖧 **Inter-server** | Typed `emitServer` / `onServer` for node-to-node coordination. |
| 🔌 **Composable** | Attaches to your `http.Server`; lifecycle hooks + middleware. |
| 🔁 **Resilient client** | Auto-reconnect, re-subscribe, in-flight reject, queue-and-flush. |
| 📈 **Scales** | Rooms, topics & inter-server events fan out across nodes via an adapter (Redis included). |

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
import { createSocketServer } from '@super-line/server'
import { chat } from './contract'

const server = http.createServer() // or pass your Express/Fastify http.Server
const srv = createSocketServer(chat, {
  server,
  authenticate: (req) => {
    const name = new URL(req.url!, 'http://x').searchParams.get('name')
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
import { createClient } from '@super-line/client'
import { chat } from './contract'

const client = createClient(chat, {
  url: 'ws://localhost:3000',
  role: 'user',                 // narrows the surface to shared ∪ user; sent to authenticate to verify
  params: { name: 'ada' },     // -> ?name=ada, read in authenticate
})

client.on('message', (m) => console.log(`${m.from}: ${m.text}`)) // typed
const sub = client.subscribe('presence', (p) => console.log(`${p.count} online`))

await client.join({ room: 'lobby' })
await client.send({ room: 'lobby', text: 'hi' }) // typed input/output; throws typed SocketError on failure

sub.unsubscribe()
client.close()
```

## Documentation

The full docs live at **[mertdogar.github.io/super-line](https://mertdogar.github.io/super-line/)**:

- **Start here** — [Getting started](https://mertdogar.github.io/super-line/guide/getting-started) · [The contract](https://mertdogar.github.io/super-line/guide/the-contract) (roles, direction & the five flavors)
- **Guides** — [Requests](https://mertdogar.github.io/super-line/guide/requests) · [Events & rooms](https://mertdogar.github.io/super-line/guide/events-rooms) · [Topics](https://mertdogar.github.io/super-line/guide/topics) · [Roles & auth](https://mertdogar.github.io/super-line/guide/roles-auth) · [Middleware & lifecycle](https://mertdogar.github.io/super-line/guide/middleware-lifecycle) · [Error handling](https://mertdogar.github.io/super-line/guide/errors) · [Reconnection & delivery](https://mertdogar.github.io/super-line/guide/reconnection-delivery) · [Serialization](https://mertdogar.github.io/super-line/guide/serialization) · [Scaling & adapters](https://mertdogar.github.io/super-line/guide/scaling-adapters) · [React](https://mertdogar.github.io/super-line/guide/react) · [Testing](https://mertdogar.github.io/super-line/guide/testing)
- **[API reference](https://mertdogar.github.io/super-line/reference/)** — generated from source: every export, option, and type across the five packages.

## Examples

```bash
pnpm install

# Node end-to-end — a human (user) and an AI (agent) in one room:
pnpm --filter @super-line/example-chat start

# Browser React chat (Vite + WS server; open two tabs to chat live):
pnpm --filter @super-line/example-react-chat dev   # http://localhost:5173

# Token auth with roles (admin-only `secret`; user gets NOT_FOUND):
pnpm --filter @super-line/example-auth start

# Multi-node fan-out via Redis + serverToServer (needs Docker/Redis):
docker run --rm -p 6379:6379 redis:7
pnpm --filter @super-line/example-scaling start
```

More on each: [examples on the docs site](https://mertdogar.github.io/super-line/examples/).

## Agent skill

This repo ships an **agent skill** that teaches AI coding agents how to use super-line — the role + direction contract model, the interaction flavors, auth, reconnection, scaling, testing, and common pitfalls. It lives in [`skills/super-line`](skills/super-line) (`SKILL.md` + `REFERENCE.md` + `RECIPES.md`).

Since skills aren't delivered via npm, copy it into your agent's skills directory:

```bash
# project-local (this repo or a consumer project)
mkdir -p .claude/skills && cp -r skills/super-line .claude/skills/
# or globally, for all your projects
cp -r skills/super-line ~/.claude/skills/
```

It activates when you import from `@super-line/*` or mention super-line.

## Comparison & FAQ

| | super-line | Socket.IO | tRPC | raw `ws` |
| --- | :---: | :---: | :---: | :---: |
| Typesafe contract | ✅ | ⚠️ types-only | ✅ | ❌ |
| Runtime validation | ✅ | ❌ | ✅ | ❌ |
| Per-role contracts | ✅ | ❌ | ❌ | ❌ |
| Req/res | ✅ | ack callbacks | ✅ | ❌ |
| Rooms | ✅ | ✅ | ❌ | ❌ |
| Topics (pub/sub) | ✅ | ⚠️ via rooms | subscriptions | ❌ |
| Inter-server messaging | ✅ | ✅ | ❌ | ❌ |
| Multi-node | ✅ adapter | ✅ adapter | ❌ | ❌ |
| Zero codegen | ✅ | ✅ | ✅ | n/a |

**Why not Socket.IO?** Socket.IO splits its types into `ClientToServerEvents` / `ServerToClientEvents` / `InterServerEvents` interfaces you maintain by hand as **positional generics** (easy to swap), with no runtime validation. super-line keeps the same directional split but in **one shared object** (can't misorder, can't drift), validates inbound automatically, and adds something Socket.IO doesn't have: **per-role contracts**. More in the [comparison & FAQ](https://mertdogar.github.io/super-line/guide/comparison-faq).

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
| [`@super-line/core`](packages/core) | `defineContract` (roles + direction), validation, wire protocol, `Serializer` / `Adapter` interfaces, `SocketError` |
| [`@super-line/server`](packages/server) | `createSocketServer` over `ws`: role-keyed `implement`, rooms, topics, `forRole`, `emitServer`/`onServer`, middleware, in-memory adapter |
| [`@super-line/client`](packages/client) | `createClient` (role-scoped surface, reconnect, typed calls, `on` / `subscribe`) |
| [`@super-line/adapter-redis`](packages/adapter-redis) | Redis Pub/Sub adapter for multi-node fan-out |
| [`@super-line/react`](packages/react) | `createSocketReact<C, Role>` → `useRequest` / `useEvent` / `useSubscription` |

## Status

Pre-1.0. **Implemented:** role-scoped contracts, req/res, events, rooms, topics, inter-server (`emitServer`/`onServer`), auth, reconnect, middleware, in-memory + Redis adapters, React hooks. **Not yet:** fire-and-forget client→server signals (every client→server is req/res today), mutable per-connection state, NATS adapter, wildcard/retained topics, session resume/replay, parameterized-topic type inference (topics are typed by exact contract key for now), backpressure safeguards.

## License

[MIT](LICENSE) © Mert
