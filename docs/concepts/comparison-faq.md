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
| Durable background jobs & cron | ✅ | ❌ | ❌ | ❌ |
| Inter-server messaging | ✅ | ✅ | ❌ | ❌ |
| Domain plugins on the contract (auth · queue · chat · inspector) | ✅ | ❌ | ⚠️ routers only | ❌ |
| Multi-node | ✅ adapter | ✅ adapter | ❌ | ❌ |
| Zero codegen | ✅ | ✅ | ✅ | n/a |

### Why not Socket.IO?

Socket.IO splits its types into `ClientToServerEvents` / `ServerToClientEvents` / `InterServerEvents` interfaces you maintain by hand and wire as **positional generics** — `Server<C2S, S2C, …>` on the server, reversed on the client, so swapping two still compiles. And its types are compile-time only: there's no runtime validation. super-line keeps the same directional split but in **one shared object** (can't misorder, can't drift), validates inbound automatically, and adds something Socket.IO doesn't have: **per-role contracts** — one server giving `user` and `agent` clients distinct, enforced surfaces. See [Server-authoritative](/concepts/server-authoritative).

### Why not tRPC?

tRPC is excellent for request/response (and SSE subscriptions), but it doesn't model rooms or client-driven pub/sub topics, and it's not built for bidirectional realtime. super-line is purpose-built for it while keeping tRPC-grade end-to-end types.

### Why not a batteries-included backend (Firebase, Supabase)?

Those platforms hand you hosted batteries — auth, a database, realtime channels, scheduled functions — but the contract is theirs: loosely-typed rows and payloads, client-driven writes you claw back with a rules language, and your domain surface living somewhere else entirely. super-line's batteries are **plugins that merge into *your* contract**: [`plugin-auth`](/how-to/plugin-auth) (sessions, API keys, JWT), [`plugin-queue`](/how-to/plugin-queue) (durable jobs and cron), [`plugin-chat`](/how-to/plugin-chat) (channels, streaming AI messages, shared channel resources), and the [Control Center inspector](/how-to/control-center) each contribute their collections and requests to the same typed, [server-authoritative](/concepts/server-authoritative) surface as your own handlers — self-hosted, one connection, no second SDK. See [the plugin model](/concepts/plugins) and the [plugin catalog](/plugins/).

### Why not a distributed event emitter?

Redis pub/sub, a wrapped `EventEmitter`, NATS — reach for one when all you need is fan-out, and you get exactly that: bytes delivered to subscribers. What you don't get is everything super-line wraps around the fan-out — a shared [contract](/concepts/the-contract), runtime validation of every inbound message, per-role surfaces, request/response correlation, and a [server-authoritative](/concepts/server-authoritative) authority that decides who may subscribe to what. super-line *uses* an emitter-shaped layer for this exact job — the pluggable [adapter](/concepts/transports-and-adapters) (Redis, libp2p, RabbitMQ, ZeroMQ) carries node↔node fan-out — but it is the typed, validated, authorized bus on top, not the raw pipe.

### Why not BullMQ, pg-boss or Agenda?

Reach for a dedicated job runner when background work is the *whole* job — a batch pipeline with no realtime surface in front of it. [`plugin-queue`](/how-to/plugin-queue) exists for the other case: an app that already has a super-line contract and needs the slow half of a request to outlive the connection that asked for it. What it adds over a standalone runner is that the job is **part of the same contract**: `input` and `result` are Standard Schema entries validated like any other, so `enqueue('sendEmail', …)` infers and rejects at the same boundary as a request handler; jobs, schedules, and concurrency slots are ordinary [collections](/collections/) in the same transaction domain as your rows, so a job and the row that caused it commit together; and the Control Center already sees them. What it deliberately doesn't add is a second datastore — no Redis instance, no separate worker deployment, no second dashboard.

The trade is scope. BullMQ has priorities, rate limiters, flows and a mature ecosystem; plugin-queue has retries, leases, per-queue concurrency, retention and cron, configured declaratively at construction and enforced by durable rows. If you need job *primitives* the plugin doesn't ship, use a dedicated runner — nothing about super-line stops you. See [Queues and workers](/concepts/queues-and-workers).

## FAQ

### Do I need Redis?

No. A single node uses the in-memory adapter. Add `@super-line/adapter-redis` — or any other adapter — only when you run more than one process. See [Choose an adapter](/how-to/choose-an-adapter).

### Do I need Redis for background jobs?

No — and the adapter isn't what makes queues work. Jobs, schedules and concurrency slots live in [collections](/collections/), so the **collection backend** decides how far they coordinate: memory or SQLite runs queues on one node, and a shared Postgres backend (`@super-line/collections-pglite`) makes claims, cancellation, cron and concurrency cluster-wide. An adapter only shortens the wake-up latency between a job landing and a node picking it up; durable polling stays the correctness path. See [Run queues across a cluster](/how-to/queue-clusters).

### Does the client work in the browser?

Yes (and Node 22+). It uses the global `WebSocket`; pass `{ WebSocket }` on older runtimes.

### How are types shared?

Put the contract in a module or package both sides import. No build step, no generated files — see [The contract](/concepts/the-contract).

### Can clients publish to topics?

No — topics are server-publish only. Send a request and have the handler publish. See [Topics](/how-to/topics).

### What's the delivery guarantee?

It depends on what is being delivered — the wire and the queue answer differently.

**Messages on the wire are at-most-once.** Offline clients miss events and topic pushes (no replay). Re-run join flows after reconnect and treat delivery as best-effort. See [Reconnection & delivery](/concepts/reconnection-delivery).

**Queue jobs are durable and at-least-once.** An enqueued job is a persisted row; it survives a restart, is claimed under a lease, and is retried on failure or after a lease expires. That means a job can run twice — the external effect may land before completion is recorded — so [workers must be idempotent](/concepts/queues-and-workers) and honor their `AbortSignal`. Use a job, not an event, whenever the work must not be lost.

In both cases the rule is the same: make handlers idempotent.

### How do I document/teach this to an AI agent?

The repo ships an [agent skill](https://github.com/mertdogar/super-line/tree/main/skills/super-line) (`SKILL.md` + `REFERENCE.md` + `RECIPES.md`) that teaches AI coding agents the model and best practices. Copy it into your agent's skills directory, or see [AI agents](/how-to/ai-agents).

### Is it stable?

Pre-1.0, but broad. Implemented: role-scoped contracts, request/response, events, rooms, topics, inter-server messaging, auth, reconnect, middleware, [connection `env`](/how-to/connection-env) (server-vended, client-visible per-connection state), plugins (inspector + auth + queue + chat), durable queues with cluster-wide cron, typed collections (last-writer-wins rows and CRDT documents) with the TanStack DB client engine, pluggable client↔server transports (WebSocket, HTTP, libp2p, loopback), pluggable server↔server adapters (in-memory, Redis, libp2p, RabbitMQ, ZeroMQ), and React hooks. Not yet: fire-and-forget signals, a NATS adapter, session resume/replay, and parameterized-topic type inference.
