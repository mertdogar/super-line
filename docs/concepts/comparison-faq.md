# Comparison & FAQ

Where super-line sits relative to the tools it's most often weighed against, and the questions that come up once you've read the model.

## How it compares

|  | super-line | Socket.IO | tRPC | raw `ws` |
| --- | :---: | :---: | :---: | :---: |
| Typesafe contract | ✅ | ⚠️ types-only | ✅ | ❌ |
| Runtime validation | ✅ | ❌ | ✅ | ❌ |
| Per-role contracts | ✅ | ❌ | ❌ | ❌ |
| Req/res | ✅ | ack callbacks | ✅ | ❌ |
| Rooms | ✅ | ✅ | ❌ | ❌ |
| Topics (pub/sub) | ✅ | ⚠️ via rooms | subscriptions | ❌ |
| Typed persisted collections | ✅ | ❌ | ❌ | ❌ |
| Inter-server messaging | ✅ | ✅ | ❌ | ❌ |
| Domain plugins on the contract (auth · chat · inspector) | ✅ | ❌ | ⚠️ routers only | ❌ |
| Multi-node | ✅ adapter | ✅ adapter | ❌ | ❌ |
| Zero codegen | ✅ | ✅ | ✅ | n/a |

### Why not Socket.IO?

Socket.IO splits its types into `ClientToServerEvents` / `ServerToClientEvents` / `InterServerEvents` interfaces you maintain by hand and wire as **positional generics** — `Server<C2S, S2C, …>` on the server, reversed on the client, so swapping two still compiles. And its types are compile-time only: there's no runtime validation. super-line keeps the same directional split but in **one shared object** (can't misorder, can't drift), validates inbound automatically, and adds something Socket.IO doesn't have: **per-role contracts** — one server giving `user` and `agent` clients distinct, enforced surfaces. See [Server-authoritative](/concepts/server-authoritative).

### Why not tRPC?

tRPC is excellent for request/response (and SSE subscriptions), but it doesn't model rooms or client-driven pub/sub topics, and it's not built for bidirectional realtime. super-line is purpose-built for it while keeping tRPC-grade end-to-end types.

### Why not a batteries-included backend (Firebase, Supabase)?

Those platforms hand you hosted batteries — auth, a database, realtime channels — but the contract is theirs: loosely-typed rows and payloads, client-driven writes you claw back with a rules language, and your domain surface living somewhere else entirely. super-line's batteries are **plugins that merge into *your* contract**: [`plugin-auth`](/how-to/plugin-auth) (sessions, API keys, JWT), [`plugin-chat`](/how-to/plugin-chat) (channels, streaming AI messages, shared channel resources), and the [Control Center inspector](/how-to/control-center) each contribute their collections and requests to the same typed, [server-authoritative](/concepts/server-authoritative) surface as your own handlers — self-hosted, one connection, no second SDK. See [the plugin model](/concepts/plugins) and the [plugin catalog](/plugins/).

### Why not a distributed event emitter?

Redis pub/sub, a wrapped `EventEmitter`, NATS — reach for one when all you need is fan-out, and you get exactly that: bytes delivered to subscribers. What you don't get is everything super-line wraps around the fan-out — a shared [contract](/concepts/the-contract), runtime validation of every inbound message, per-role surfaces, request/response correlation, and a [server-authoritative](/concepts/server-authoritative) authority that decides who may subscribe to what. super-line *uses* an emitter-shaped layer for this exact job — the pluggable [adapter](/concepts/transports-and-adapters) (Redis, libp2p, RabbitMQ, ZeroMQ) carries node↔node fan-out — but it is the typed, validated, authorized bus on top, not the raw pipe.

## FAQ

### Do I need Redis?

No. A single node uses the in-memory adapter. Add `@super-line/adapter-redis` — or any other adapter — only when you run more than one process. See [Choose an adapter](/how-to/choose-an-adapter).

### Does the client work in the browser?

Yes (and Node 22+). It uses the global `WebSocket`; pass `{ WebSocket }` on older runtimes.

### How are types shared?

Put the contract in a module or package both sides import. No build step, no generated files — see [The contract](/concepts/the-contract).

### Can clients publish to topics?

No — topics are server-publish only. Send a request and have the handler publish. See [Topics](/how-to/topics).

### What's the delivery guarantee?

At-most-once. Offline clients miss messages (no replay). Make handlers idempotent and re-run join flows after reconnect. See [Reconnection & delivery](/concepts/reconnection-delivery).

### How do I document/teach this to an AI agent?

The repo ships an [agent skill](https://github.com/mertdogar/super-line/tree/main/skills/super-line) (`SKILL.md` + `REFERENCE.md` + `RECIPES.md`) that teaches AI coding agents the model and best practices. Copy it into your agent's skills directory, or see [AI agents](/how-to/ai-agents).

### Is it stable?

Pre-1.0, but broad. Implemented: role-scoped contracts, request/response, events, rooms, topics, inter-server messaging, auth, reconnect, middleware, [connection `env`](/how-to/connection-env) (server-vended, client-visible per-connection state), plugins (inspector + auth + chat), typed collections (last-writer-wins rows and CRDT documents) with the TanStack DB client engine, pluggable client↔server transports (WebSocket, HTTP, libp2p, loopback), pluggable server↔server adapters (in-memory, Redis, libp2p, RabbitMQ, ZeroMQ), and React hooks. Not yet: fire-and-forget signals, a NATS adapter, session resume/replay, and parameterized-topic type inference.
