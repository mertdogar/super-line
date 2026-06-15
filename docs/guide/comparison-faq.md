# Comparison & FAQ

## How it compares

|  | super-line | Socket.IO | tRPC | raw `ws` |
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

### Why not Socket.IO?

Socket.IO splits its types into `ClientToServerEvents` / `ServerToClientEvents` / `InterServerEvents` interfaces you maintain by hand and wire as **positional generics** — `Server<C2S, S2C, …>` on the server, reversed on the client, so swapping two still compiles. And its types are compile-time only: there's no runtime validation. super-line keeps the same directional split but in **one shared object** (can't misorder, can't drift), validates inbound automatically, and adds something Socket.IO doesn't have: **per-role contracts** — one server giving `user` and `agent` clients distinct, enforced surfaces.

### Why not tRPC?

tRPC is excellent for request/response (and SSE subscriptions), but it doesn't model rooms or client-driven pub/sub topics, and it's not built for bidirectional realtime. super-line is purpose-built for it while keeping tRPC-grade end-to-end types.

## FAQ

### Do I need Redis?

No. A single node uses the in-memory adapter. Add `@super-line/adapter-redis` only when you run more than one process. See [Scaling & adapters](./scaling-adapters).

### Does the client work in the browser?

Yes (and Node 22+). It uses the global `WebSocket`; pass `{ WebSocket }` on older runtimes.

### How are types shared?

Put the contract in a module/package both sides import. No build step, no generated files.

### Can clients publish to topics?

No — topics are server-publish only. Send a request and have the handler publish. See [Topics → Client → others](./topics#client-others).

### What's the delivery guarantee?

At-most-once. Offline clients miss messages (no replay). Make handlers idempotent and re-run join flows after reconnect. See [Reconnection & delivery](./reconnection-delivery).

### How do I document/teach this to an AI agent?

The repo ships an [agent skill](https://github.com/mertdogar/super-line/tree/main/skills/super-line) (`SKILL.md` + `REFERENCE.md` + `RECIPES.md`) that teaches AI coding agents the model and best practices. Copy it into your agent's skills directory.

### Is it stable?

Pre-1.0. Implemented: role-scoped contracts, req/res, events, rooms, topics, inter-server, auth, reconnect, middleware, in-memory + Redis adapters, React hooks. Not yet: fire-and-forget signals, mutable per-connection state, NATS adapter, session resume/replay, parameterized-topic type inference.
