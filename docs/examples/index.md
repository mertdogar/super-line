# Examples

Runnable examples live in [`examples/`](https://github.com/mertdogar/super-line/tree/main/examples). Clone the repo and run `pnpm install` first.

## chat — roles in one room

A human (`user`) and an AI participant (`agent`) join the **same room** with different surfaces. Shows a `shared` `join` + `message` event, role-specific verbs (`say` vs `announce`), and `conn.role`.

```bash
pnpm --filter @super-line/example-chat start
```

Demonstrates: [roles](/how-to/roles-auth), [shared requests](/how-to/requests), [events & rooms](/how-to/events-rooms).

## react-chat — browser app

A live React chat (Vite + a WS server). Open two browser tabs to chat in real time; shows the [React hooks](/how-to/react), a presence [topic](/how-to/topics), and a room broadcast.

```bash
pnpm --filter @super-line/example-react-chat dev   # http://localhost:5173
```

## collections-chat — a Slack-like app on the chat plugin (+ a live AI agent)

The flagship showcase for [`@super-line/plugin-chat`](/how-to/plugin-chat): a Slack-like app whose **entire durable model** — public/private channels, owner/member roles, send/edit/delete — comes from the plugin, with identity from [`@super-line/plugin-auth`](/how-to/plugin-auth). Sign up with a real email + password, create channels, manage membership (try to remove the last owner and the server refuses), and edit or delete your own messages — every mutation is a [server-authoritative request](/how-to/plugin-chat), not an optimistic row-write ([ADR-0010](https://github.com/mertdogar/super-line/blob/main/docs/adr/0010-plugin-domain-surfaces-are-requests-first-with-domain-hooks.md)). The server declares **no** channel/message policies or handlers of its own — only ephemeral presence/typing garnish, proving host-land signals still compose on a plugin backbone. Every new user lands in **#ask-ai**, where a bot — a *genuine user* the server provisions and runs as a headless `chatClient` — replies (canned offline by default; a [Vercel AI Gateway](https://vercel.com/ai-gateway) key gives it a real brain). The bot is a Vercel AI SDK `ToolLoopAgent` wired with the plugin's [`chatAgentTools`](/how-to/plugin-chat), so it can read the room over its own permission-checked connection before answering. Vite + React 19 + Tailwind v4 + shadcn/ui, durable to SQLite.

```bash
pnpm --filter @super-line/example-collections-chat dev   # web http://localhost:5173 · server ws://localhost:8791
```

Demonstrates: [the chat plugin](/how-to/plugin-chat), [plugin auth](/how-to/plugin-auth), [row-level policies](/collections/policies), the imperative `chatKit` + [AI agents](/how-to/ai-agents).

## store-sync-json — a collaborative JSON editor (CRDT)

A React app over a [CRDT document collection](/collections/crdt-documents) (`@super-line/collections-crdt-memory`, Yjs-backed): a [`@visual-json`](https://visual-json.dev) editor bound to one shared document via [`useDoc`](/how-to/react). Open two tabs (or add `?name=bob`), edit any field, and watch edits **merge** live — concurrent edits to different fields both survive, unlike last-writer-wins. **Server nudge** triggers a server co-write.

```bash
pnpm --filter @super-line/example-store-sync-json dev   # http://localhost:5273
```

Demonstrates: [CRDT document collections](/collections/crdt-documents), [React hooks](/how-to/react).

## synced-canvas — roll-your-own CRDT (raw relay)

Two browser apps demonstrating **synced JSON state over super-line, backed by a CRDT** — a collaborative canvas where multiple tabs *and the server* co-edit one document, persisted server-side. super-line stays CRDT-agnostic: it relays opaque base64 update bytes per room and never parses the doc. A debug side panel mirrors the live state and logs each patch tagged by origin (`local` / `peer` / `server`), so you can watch the server's edits land. Built once with [Yjs](https://github.com/yjs/yjs) and once with [Automerge](https://automerge.org) — open either in two windows (run one at a time).

```bash
pnpm --filter @super-line/example-synced-canvas-yjs dev         # http://localhost:5173
pnpm --filter @super-line/example-synced-canvas-automerge dev   # http://localhost:5173
```

Demonstrates: [CRDT document collections](/collections/), [events & rooms](/how-to/events-rooms), [requests](/how-to/requests).

## ai-canvas — a server-side AI agent as a co-writer

The [synced-canvas](#synced-canvas-roll-your-own-crdt-raw-relay) board rebuilt on a [CRDT document collection](/collections/crdt-documents) (`@super-line/collections-crdt-memory` in `document` mode — typed and validated on every write), with a **server-side LLM agent that co-edits the same board**. Type a prompt ("add three blue squares in a row, then delete the red one") — a single `agentEdit` request opens a reactive co-writer (`srv.collection('scene').open(id)`), reads the live board (`getSnapshot`), and drives it with four tools mapped onto doc primitives — `update` to add/move/recolor, `delete(path)` to remove. The agent's edits fan out to every tab and **merge** with your concurrent drags (document-mode CRDT), so you can keep editing while it works. Built with the [AI SDK](https://ai-sdk.dev) over the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway); the board itself is a fully working collaborative canvas even without a key. Open two windows (`?name=ada`, `?name=bob`) — server and web bind `0.0.0.0`, so a phone on the same network can join too.

```bash
cp examples/ai-canvas/.env.example examples/ai-canvas/.env   # set AI_GATEWAY_API_KEY
pnpm --filter @super-line/example-ai-canvas dev   # http://localhost:5373
```

Demonstrates: [CRDT document collections](/collections/crdt-documents), the reactive server-side co-writer, [React hooks](/how-to/react).

## ai-canvas-pglite — the AI canvas, re-clustered over Postgres + Electric

The [ai-canvas](#ai-canvas-a-server-side-ai-agent-as-a-co-writer) board re-clustered across **two nodes** on the self-clustering [`@super-line/collections-crdt-pglite`](/collections/crdt-documents) **CRDT document collection**. Same UX — drag shapes, ask a server-side AI agent ("add three blue circles in a row, then delete the red one") — but CRDT convergence rides **central Postgres + Electric**, not super-line's adapter. Every write is validated against the contract schema, then appended as an opaque Yjs delta to an append-only op-log in Postgres; Electric streams it to each node's in-memory PGlite replica, which folds the deltas and fans them to its local tabs. Concurrent edits to *different* shapes merge across nodes (`clustering: 'self'`). A separate broker-less libp2p mesh carries presence/inspector so the Control Center sees the whole cluster. Needs Docker; the board works without an AI Gateway key (only the agent request needs one).

```bash
cp examples/ai-canvas-pglite/.env.example examples/ai-canvas-pglite/.env   # set AI_GATEWAY_API_KEY
docker compose -f examples/ai-canvas-pglite/docker-compose.yml up --build
```

Open `http://localhost:8200` (node-1) and `http://localhost:8200/?node=2` (node-2); Control Center at `http://localhost:8201`.

Demonstrates: [CRDT document collections](/collections/crdt-documents), the reactive server-side co-writer, self-clustering (Postgres + Electric).

## hono — one server for HTTP + WebSockets

super-line attached to a [Hono](https://hono.dev) app (`@hono/node-server`) on **one process, one port**: Hono serves the built frontend and REST routes while super-line owns the WebSocket bus, both on the same Node `http.Server` (the `{ server }` option — no library changes). Three live cards — a server-uptime [topic](/how-to/topics), shared todos (req/res + a topic), and shared cursors whose identity is assigned server-side into `ctx` — plus a `POST /api/todos` **REST→WS bridge**: `curl` a todo in and watch it appear in every open tab. The bridge route and the WS upgrade share one auth rule. Open a few tabs and move your mouse.

```bash
pnpm --filter @super-line/example-hono build
pnpm --filter @super-line/example-hono start   # http://localhost:3000
```

Demonstrates: [topics](/how-to/topics), [requests](/how-to/requests), [middleware & lifecycle](/how-to/middleware-lifecycle), composing with an HTTP framework.

## transports — same app, any wire

The headline of pluggable transports: **one contract, one server, identical client code — over WebSocket, HTTP (SSE), and libp2p at once.** A single server mounts all three server transports; three clients call the exact same `echo` with only the transport line differing, and one server push fans out to every wire. Same handlers, same validation, same rooms/topics — the transport is just the pipe, swappable per deployment without touching application code.

```bash
pnpm --filter @super-line/example-transports start
```

Demonstrates: [transports](/how-to/choose-a-transport), [the HTTP transport](/how-to/transport-http), [the libp2p transport](/how-to/transport-libp2p).

## react-chat-transports — the browser app with a live transport dial

A React chat with a transport dropdown: flip between **WebSocket**, **HTTP (SSE)**, and **libp2p** live in the browser. The contract, handlers, hooks, and UI are identical — only the client transport line changes, and each message shows the wire it arrived on (the server stamps `h.transport` into `ctx`). Single node by design: this is the *client*-transport axis, not server↔server fan-out (for that, see the `react-chat-cluster-*` examples). Needs Docker (or run the server + SPA locally).

```bash
cd examples/react-chat-transports && docker compose up --build
```

Chat at `http://localhost:8100`, Control Center at `http://localhost:8101`.

Demonstrates: [transports](/how-to/choose-a-transport), [React hooks](/how-to/react), [the HTTP transport](/how-to/transport-http).

## auth — roles as an authorization boundary

Token auth with an `admin` and a `user` role. `whoami` is shared; `secret` is admin-only. A user calling `secret` gets `NOT_FOUND`; a bad token is rejected at the upgrade.

```bash
pnpm --filter @super-line/example-auth start
```

Demonstrates: [auth](/how-to/roles-auth), [`NOT_FOUND` enforcement](/how-to/roles-auth), [errors](/how-to/errors).

## presence — introspection, targeted send & server→client requests

Boots **two nodes** sharing one in-memory bus (no Docker needed) and shows the server-side toolkit across nodes: `cluster.count`/`topology`/`isOnline`, a `toUser(...).emit` from the node that *doesn't* hold the socket, and a `toConn(id).request(...)` where one node asks a client a question and awaits the typed reply (the client answers via `client.implement`).

```bash
pnpm --filter @super-line/example-presence start
```

Demonstrates: [introspection & presence](/how-to/introspection-and-presence).

## event-bus — single-process cluster event bus

One process shows the [cluster event bus](/how-to/cluster-event-bus) on a shared topic: a `server.publish` fans out to several in-process `server.subscribe` listeners (showing local echo — your own publish fires in-process, no round-trip) plus one client subscriber over WS. No Redis needed.

```bash
pnpm --filter @super-line/example-event-bus start
```

Demonstrates: [the cluster event bus](/how-to/cluster-event-bus).

## bus-cluster — multi-node server.subscribe showcase

A cluster via Docker Compose: **Redis + Caddy + 3 server nodes + watcher clients**. Every node bumps a counter and `server.subscribe`s to every node's bumps, converging a shared tally — own bumps land in-process via local echo, peers' arrive over Redis. node-1 publishes a client-facing `total` snapshot. Needs Docker.

```bash
cd examples/bus-cluster && docker compose up
```

Demonstrates: [the cluster event bus](/how-to/cluster-event-bus), [scaling & adapters](/how-to/choose-an-adapter).

## scaling — a real multi-node cluster

A genuine cluster via Docker Compose: **Redis + a Caddy load balancer + 3 server nodes + 6 client containers**. Caddy round-robins each client onto a node; you watch room broadcasts, a topic, and `stats` gossip — migrated to a shared `stats` topic over the cluster event bus — fan out across separate processes. Needs Docker.

```bash
cd examples/scaling && docker compose up
```

See [`examples/scaling/README.md`](https://github.com/mertdogar/super-line/tree/main/examples/scaling) for what to watch, how to connect your own client to the load balancer, and `--scale`.

Demonstrates: [scaling & adapters](/how-to/choose-an-adapter), [the cluster event bus](/how-to/cluster-event-bus).

## scaling-rabbitmq — the same cluster over RabbitMQ

[`scaling`](#scaling-a-real-multi-node-cluster) with **RabbitMQ** as the substrate instead of Redis (via [`@super-line/adapter-rabbitmq`](/how-to/adapter-rabbitmq)): RabbitMQ + a Caddy load balancer + 3 nodes + 6 client containers. Channels become routing keys on a `direct` exchange, so the broker selectively routes each message only to the nodes that subscribed. Same room/topic/cluster-event-bus fan-out across processes; the only structural change is the (async) adapter factory. The RabbitMQ management UI is at `http://localhost:15672` (`superline` / `superline`). Needs Docker.

```bash
cd examples/scaling-rabbitmq && docker compose up
```

Demonstrates: [scaling & adapters](/how-to/choose-an-adapter), [the RabbitMQ adapter](/how-to/adapter-rabbitmq), [the cluster event bus](/how-to/cluster-event-bus).

## scaling-zeromq — the same cluster, brokerless over ZeroMQ

[`scaling`](#scaling-a-real-multi-node-cluster) with **no Redis** — the nodes peer directly over a [ZeroMQ](https://zeromq.org) mesh via [`@super-line/adapter-zeromq`](/how-to/adapter-zeromq). One shared mesh fans out all three flows (room broadcast, topic, and `stats` over the cluster event bus). Discovery is just **plain DNS names** on the compose network — no broker, no peer IDs, no registry; ZeroMQ's `connect` is lazy and auto-reconnecting, so nodes start in any order. Mesh mode suits a handful of nodes; for a larger fleet run a forwarder (`npx super-line-zeromq-proxy`). Needs Docker.

```bash
cd examples/scaling-zeromq && docker compose up
```

Demonstrates: [scaling & adapters](/how-to/choose-an-adapter), [the ZeroMQ adapter](/how-to/adapter-zeromq), [the cluster event bus](/how-to/cluster-event-bus).

## react-chat-cluster — the browser app, across two servers

[`react-chat`](#react-chat-browser-app) behind a real cluster via Docker Compose: **Redis + 2 server nodes + a Caddy** that serves the built SPA *and* round-robins `/ws` across the nodes. Open `http://localhost:8080` in several tabs — each lands on a different node (shown in the header), yet messages cross servers via a `room.broadcast` over the Redis adapter, and the online count is cluster-wide via `cluster.room(...)`. Needs Docker.

```bash
cd examples/react-chat-cluster && docker compose up
```

See [`examples/react-chat-cluster/README.md`](https://github.com/mertdogar/super-line/tree/main/examples/react-chat-cluster) for the topology and what each tab shows.

Demonstrates: [React hooks](/how-to/react), [scaling & adapters](/how-to/choose-an-adapter), [introspection & presence](/how-to/introspection-and-presence).

## react-chat-cluster-libp2p — the same cluster, no broker

The same browser app and Control Center as `react-chat-cluster` above, but with **no Redis** — the two nodes peer directly over libp2p gossipsub via [`@super-line/adapter-libp2p`](/how-to/adapter-libp2p). Same React SPA, same cross-node messages and cluster-wide (gossip-replicated) presence; the only structural change is the adapter line. Ports are offset (web `:8090`, Control Center `:8091`) so it runs alongside the Redis variant. Needs Docker.

```bash
cd examples/react-chat-cluster-libp2p && docker compose up --build
```

Demonstrates: [React hooks](/how-to/react), [scaling & adapters](/how-to/adapter-libp2p), [introspection & presence](/how-to/introspection-and-presence).

## react-chat-cluster-rabbitmq — the same cluster over RabbitMQ

[`react-chat-cluster`](#react-chat-cluster-the-browser-app-across-two-servers) with **RabbitMQ** as the broker (via [`@super-line/adapter-rabbitmq`](/how-to/adapter-rabbitmq)) instead of Redis — same React SPA, same Control Center. A single Caddy serves the SPA and `round_robin`s `/ws` across two nodes; messages cross process boundaries through the broker, and the cluster-wide online count comes from the adapter's **gossip-replicated** presence directory (eventually consistent — RabbitMQ has no shared key-value store). The only structural change from the Redis variant is the (async) adapter line. Ports are offset so all three cluster variants run at once. Needs Docker.

```bash
cd examples/react-chat-cluster-rabbitmq && docker compose up --build
```

App at `http://localhost:8100`, Control Center at `http://localhost:8101`; RabbitMQ management UI at `http://localhost:15673`.

Demonstrates: [React hooks](/how-to/react), [the RabbitMQ adapter](/how-to/adapter-rabbitmq), [introspection & presence](/how-to/introspection-and-presence).

## react-chat-cluster-zeromq — delete your broker

[`react-chat-cluster`](#react-chat-cluster-the-browser-app-across-two-servers) with **Redis deleted** — same React app, same Control Center, same behavior, but **no broker service** in the stack. Three nodes peer directly over a [ZeroMQ](https://zeromq.org) mesh (via [`@super-line/adapter-zeromq`](/how-to/adapter-zeromq)), so a message typed in a tab on node-1 still reaches a tab on node-3. The only code change is the adapter line; discovery is just DNS names on the compose network. The Control Center is the best way to *see* the brokerless mesh — no broker box in the topology, the three nodes peering directly. Needs Docker.

```bash
cd examples/react-chat-cluster-zeromq && docker compose up --build
```

App at `http://localhost:8080`, Control Center at `http://localhost:8081`.

Demonstrates: [React hooks](/how-to/react), [the ZeroMQ adapter](/how-to/adapter-zeromq), [introspection & presence](/how-to/introspection-and-presence).

## libp2p-nat — servers behind NAT, browsers over WebRTC

A chat cluster where the **servers aren't directly reachable** — their libp2p nodes advertise *only* a `/p2p-circuit` reservation and `/webrtc`. Browser clients, sitting outside the network entirely, reach them over **WebRTC**, signalled through one small public relay that also lets the servers discover and mesh with each other. One libp2p node per server feeds both the libp2p **transport** (browser↔server) and the libp2p **adapter** (server↔server); STUN (`src/ice.ts`) is what lets WebRTC cross real NATs (a phone on cellular reaching a server behind a home router). Reuses the [`react-chat-cluster-libp2p`](#react-chat-cluster-libp2p-the-same-cluster-no-broker) contract and UI nearly unchanged — only the connectivity differs. Needs Docker.

```bash
cd examples/libp2p-nat && docker compose up --build
```

Chat at `http://localhost:8080`, Control Center at `http://localhost:8091`.

Demonstrates: [the libp2p transport](/how-to/transport-libp2p), [the libp2p adapter](/how-to/adapter-libp2p), [scaling & adapters](/how-to/choose-an-adapter).
