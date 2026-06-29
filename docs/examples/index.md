# Examples

Runnable examples live in [`examples/`](https://github.com/mertdogar/super-line/tree/main/examples). Clone the repo and run `pnpm install` first.

## chat — roles in one room

A human (`user`) and an AI participant (`agent`) join the **same room** with different surfaces. Shows a `shared` `join` + `message` event, role-specific verbs (`say` vs `announce`), and `conn.role`.

```bash
pnpm --filter @super-line/example-chat start
```

Demonstrates: [roles](/guide/roles-auth), [shared requests](/guide/requests), [events & rooms](/guide/events-rooms).

## react-chat — browser app

A live React chat (Vite + a WS server). Open two browser tabs to chat in real time; shows the [React hooks](/guide/react), a presence [topic](/guide/topics), and a room broadcast.

```bash
pnpm --filter @super-line/example-react-chat dev   # http://localhost:5173
```

## advanced-chat-app — a Slack-like app, persisted to SQLite

A polished Slack clone (Vite + React 19 + Tailwind v4 + shadcn/ui, using the [shadcn-chat](https://shadcn-chat.vercel.app) blocks): a channel sidebar with **live unread badges**, presence, typing indicators, and a create-channel button. Channels and message history live in a [Store](/guide/store) and are **persisted to SQLite** via [`@super-line/store-sqlite`](/guide/store) — so the workspace survives a server restart and streams live to every client. The server is the sole writer (`createChannel`/`send` requests); clients read the channel index and per-channel message Resources with [`useResource`](/guide/react). Open two windows (`?name=ada`, `?name=bob`).

```bash
pnpm --filter @super-line/example-advanced-chat-app dev   # http://localhost:5173
```

Demonstrates: [stores](/guide/store) + durable persistence, [requests](/guide/requests), [topics](/guide/topics), [React hooks](/guide/react).

## store — a permissioned document store

A scripted, single-process demo of the [Store](/guide/store) primitive on the in-memory LWW backend. The server creates a permissioned note and assigns per-user access; two users open it and one's write reaches the other live; a read-only user is denied a write (`FORBIDDEN`); a third user can't open the doc until the server grants access at runtime; and the server co-writes the document.

```bash
pnpm --filter @super-line/example-store start
```

Demonstrates: [stores](/guide/store), [roles](/guide/roles-auth), [errors](/guide/errors).

## store-sync-json — a collaborative JSON editor (CRDT)

A React app over the [CRDT Store](/guide/synced-state) (`@super-line/store-sync` — Yjs via super-store): a [`@visual-json`](https://visual-json.dev) editor bound to one shared Resource via [`useResource`](/guide/react). Open two tabs (or add `?name=bob`), edit any field, and watch edits **merge** live — concurrent edits to different fields both survive, unlike last-writer-wins. **Server nudge** triggers a server co-write.

```bash
pnpm --filter @super-line/example-store-sync-json dev   # http://localhost:5273
```

Demonstrates: [synced state (CRDT)](/guide/synced-state), [stores](/guide/store), [React hooks](/guide/react).

## synced-canvas — roll-your-own CRDT (no Store seam)

Two browser apps demonstrating **synced JSON state over super-line, backed by a CRDT** — a collaborative canvas where multiple tabs *and the server* co-edit one document, persisted server-side. super-line stays CRDT-agnostic: it relays opaque base64 update bytes per room and never parses the doc. A debug side panel mirrors the live state and logs each patch tagged by origin (`local` / `peer` / `server`), so you can watch the server's edits land. Built once with [Yjs](https://github.com/yjs/yjs) and once with [Automerge](https://automerge.org) — open either in two windows (run one at a time).

```bash
pnpm --filter @super-line/example-synced-canvas-yjs dev         # http://localhost:5173
pnpm --filter @super-line/example-synced-canvas-automerge dev   # http://localhost:5173
```

Demonstrates: [synced state (CRDT)](/guide/synced-state), [events & rooms](/guide/events-rooms), [requests](/guide/requests).

## ai-canvas — a server-side AI agent as a co-writer

The [synced-canvas](#synced-canvas-roll-your-own-crdt-no-store-seam) board rebuilt on the [CRDT Store](/guide/synced-state) (`@super-line/store-sync` in `document` mode), with a **server-side LLM agent that co-edits the same board**. Type a prompt ("add three blue squares in a row, then delete the red one") — a single `agentEdit` request opens a [reactive co-writer](/guide/store#a-reactive-server-side-co-writer) (`srv.store('scene').open(id)`), reads the live board (`getSnapshot`), and drives it with four tools mapped onto Store primitives — `update` to add/move/recolor, `delete(path)` to remove. The agent's edits fan out to every tab and **merge** with your concurrent drags (document-mode CRDT), so you can keep editing while it works. Built with the [AI SDK](https://ai-sdk.dev) over the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway); the board itself is a fully working collaborative canvas even without a key. Open two windows (`?name=ada`, `?name=bob`) — server and web bind `0.0.0.0`, so a phone on the same network can join too.

```bash
cp examples/ai-canvas/.env.example examples/ai-canvas/.env   # set AI_GATEWAY_API_KEY
pnpm --filter @super-line/example-ai-canvas dev   # http://localhost:5373
```

Demonstrates: [the reactive server-side co-writer](/guide/store#a-reactive-server-side-co-writer), [synced state (CRDT)](/guide/synced-state), [stores](/guide/store), [React hooks](/guide/react).

## ai-canvas-pglite — the AI canvas, re-clustered over Postgres + Electric

The [ai-canvas](#ai-canvas-a-server-side-ai-agent-as-a-co-writer) board re-clustered across **two nodes** on the [`@super-line/store-sync-pglite`](/guide/choosing-a-store) **CRDT** store. Same UX — drag shapes, ask a server-side AI agent ("add three blue circles in a row, then delete the red one") — but CRDT convergence rides **central Postgres + Electric**, not super-line's adapter. Every write appends an opaque Yjs delta to an append-only op-log in Postgres; Electric streams it to each node's in-memory PGlite replica, which folds the deltas and fans them to its local tabs. Concurrent edits to *different* shapes merge across nodes (`clustering: 'self'`). A separate broker-less libp2p mesh carries presence/inspector so the Control Center sees the whole cluster. Needs Docker; the board works without an AI Gateway key (only the agent request needs one).

```bash
cp examples/ai-canvas-pglite/.env.example examples/ai-canvas-pglite/.env   # set AI_GATEWAY_API_KEY
docker compose -f examples/ai-canvas-pglite/docker-compose.yml up --build
```

Open `http://localhost:8200` (node-1) and `http://localhost:8200/?node=2` (node-2); Control Center at `http://localhost:8201`.

Demonstrates: [synced state (CRDT)](/guide/synced-state), [the reactive server-side co-writer](/guide/store#a-reactive-server-side-co-writer), [choosing a store](/guide/choosing-a-store).

## store-pglite — a self-clustering store over Postgres + Electric

A cluster where the **store owns its cross-node sync** (`clustering: 'self'`) — the store needs **no super-line adapter**; central Postgres + Electric is its only fan-out. Writes, strong reads, and ACL go to Postgres via `postgres.js`; each node keeps an in-memory PGlite replica that Electric streams to, and `live.changes` fans changes to that node's local clients only. A write round-trips `node → Postgres → Electric → every node's replica`. Every node runs identical code with **no cluster-size knowledge** — peers find each other over mDNS, so adding a node-3 needs zero config. A separate broker-less libp2p mesh carries presence/inspector so the Control Center sees the whole cluster. Needs Docker.

```bash
cd examples/store-pglite && docker compose up --build
```

Watch `writer@node-1 → set count=N` and `reader@node-2 ← room count=N` cross nodes through Electric; Control Center at `http://localhost:8081`.

Demonstrates: [stores](/guide/store), [choosing a store](/guide/choosing-a-store), [scaling & adapters](/guide/scaling-adapters).

## hono — one server for HTTP + WebSockets

super-line attached to a [Hono](https://hono.dev) app (`@hono/node-server`) on **one process, one port**: Hono serves the built frontend and REST routes while super-line owns the WebSocket bus, both on the same Node `http.Server` (the `{ server }` option — no library changes). Three live cards — a server-uptime [topic](/guide/topics), shared todos (req/res + a topic), and shared cursors whose identity is assigned server-side into `ctx` — plus a `POST /api/todos` **REST→WS bridge**: `curl` a todo in and watch it appear in every open tab. The bridge route and the WS upgrade share one auth rule. Open a few tabs and move your mouse.

```bash
pnpm --filter @super-line/example-hono build
pnpm --filter @super-line/example-hono start   # http://localhost:3000
```

Demonstrates: [topics](/guide/topics), [requests](/guide/requests), [middleware & lifecycle](/guide/middleware-lifecycle), composing with an HTTP framework.

## transports — same app, any wire

The headline of pluggable transports: **one contract, one server, identical client code — over WebSocket, HTTP (SSE), and libp2p at once.** A single server mounts all three server transports; three clients call the exact same `echo` with only the transport line differing, and one server push fans out to every wire. Same handlers, same validation, same rooms/topics — the transport is just the pipe, swappable per deployment without touching application code.

```bash
pnpm --filter @super-line/example-transports start
```

Demonstrates: [transports](/guide/transports), [the HTTP transport](/guide/transport-http), [the libp2p transport](/guide/transport-libp2p).

## react-chat-transports — the browser app with a live transport dial

A React chat with a transport dropdown: flip between **WebSocket**, **HTTP (SSE)**, and **libp2p** live in the browser. The contract, handlers, hooks, and UI are identical — only the client transport line changes, and each message shows the wire it arrived on (the server stamps `h.transport` into `ctx`). Single node by design: this is the *client*-transport axis, not server↔server fan-out (for that, see the `react-chat-cluster-*` examples). Needs Docker (or run the server + SPA locally).

```bash
cd examples/react-chat-transports && docker compose up --build
```

Chat at `http://localhost:8100`, Control Center at `http://localhost:8101`.

Demonstrates: [transports](/guide/transports), [React hooks](/guide/react), [the HTTP transport](/guide/transport-http).

## auth — roles as an authorization boundary

Token auth with an `admin` and a `user` role. `whoami` is shared; `secret` is admin-only. A user calling `secret` gets `NOT_FOUND`; a bad token is rejected at the upgrade.

```bash
pnpm --filter @super-line/example-auth start
```

Demonstrates: [auth](/guide/roles-auth), [`NOT_FOUND` enforcement](/guide/roles-auth#enforcement-not-found), [errors](/guide/errors).

## presence — introspection, targeted send & server→client requests

Boots **two nodes** sharing one in-memory bus (no Docker needed) and shows the server-side toolkit across nodes: `cluster.count`/`topology`/`isOnline`, a `toUser(...).emit` from the node that *doesn't* hold the socket, and a `toConn(id).request(...)` where one node asks a client a question and awaits the typed reply (the client answers via `client.implement`).

```bash
pnpm --filter @super-line/example-presence start
```

Demonstrates: [introspection & presence](/guide/introspection-and-presence).

## event-bus — single-process cluster event bus

One process shows the [cluster event bus](/guide/cluster-event-bus) on a shared topic: a `server.publish` fans out to several in-process `server.subscribe` listeners (showing local echo — your own publish fires in-process, no round-trip) plus one client subscriber over WS. No Redis needed.

```bash
pnpm --filter @super-line/example-event-bus start
```

Demonstrates: [the cluster event bus](/guide/cluster-event-bus).

## bus-cluster — multi-node server.subscribe showcase

A cluster via Docker Compose: **Redis + Caddy + 3 server nodes + watcher clients**. Every node bumps a counter and `server.subscribe`s to every node's bumps, converging a shared tally — own bumps land in-process via local echo, peers' arrive over Redis. node-1 publishes a client-facing `total` snapshot. Needs Docker.

```bash
cd examples/bus-cluster && docker compose up
```

Demonstrates: [the cluster event bus](/guide/cluster-event-bus), [scaling & adapters](/guide/scaling-adapters).

## scaling — a real multi-node cluster

A genuine cluster via Docker Compose: **Redis + a Caddy load balancer + 3 server nodes + 6 client containers**. Caddy round-robins each client onto a node; you watch room broadcasts, a topic, and `stats` gossip — migrated to a shared `stats` topic over the cluster event bus — fan out across separate processes. Needs Docker.

```bash
cd examples/scaling && docker compose up
```

See [`examples/scaling/README.md`](https://github.com/mertdogar/super-line/tree/main/examples/scaling) for what to watch, how to connect your own client to the load balancer, and `--scale`.

Demonstrates: [scaling & adapters](/guide/scaling-adapters), [the cluster event bus](/guide/cluster-event-bus).

## scaling-rabbitmq — the same cluster over RabbitMQ

[`scaling`](#scaling-a-real-multi-node-cluster) with **RabbitMQ** as the substrate instead of Redis (via [`@super-line/adapter-rabbitmq`](/guide/adapter-rabbitmq)): RabbitMQ + a Caddy load balancer + 3 nodes + 6 client containers. Channels become routing keys on a `direct` exchange, so the broker selectively routes each message only to the nodes that subscribed. Same room/topic/cluster-event-bus fan-out across processes; the only structural change is the (async) adapter factory. The RabbitMQ management UI is at `http://localhost:15672` (`superline` / `superline`). Needs Docker.

```bash
cd examples/scaling-rabbitmq && docker compose up
```

Demonstrates: [scaling & adapters](/guide/scaling-adapters), [the RabbitMQ adapter](/guide/adapter-rabbitmq), [the cluster event bus](/guide/cluster-event-bus).

## scaling-zeromq — the same cluster, brokerless over ZeroMQ

[`scaling`](#scaling-a-real-multi-node-cluster) with **no Redis** — the nodes peer directly over a [ZeroMQ](https://zeromq.org) mesh via [`@super-line/adapter-zeromq`](/guide/adapter-zeromq). One shared mesh fans out all three flows (room broadcast, topic, and `stats` over the cluster event bus). Discovery is just **plain DNS names** on the compose network — no broker, no peer IDs, no registry; ZeroMQ's `connect` is lazy and auto-reconnecting, so nodes start in any order. Mesh mode suits a handful of nodes; for a larger fleet run a forwarder (`npx super-line-zeromq-proxy`). Needs Docker.

```bash
cd examples/scaling-zeromq && docker compose up
```

Demonstrates: [scaling & adapters](/guide/scaling-adapters), [the ZeroMQ adapter](/guide/adapter-zeromq), [the cluster event bus](/guide/cluster-event-bus).

## react-chat-cluster — the browser app, across two servers

[`react-chat`](#react-chat-browser-app) behind a real cluster via Docker Compose: **Redis + 2 server nodes + a Caddy** that serves the built SPA *and* round-robins `/ws` across the nodes. Open `http://localhost:8080` in several tabs — each lands on a different node (shown in the header), yet messages cross servers via a `room.broadcast` over the Redis adapter, and the online count is cluster-wide via `cluster.room(...)`. Needs Docker.

```bash
cd examples/react-chat-cluster && docker compose up
```

See [`examples/react-chat-cluster/README.md`](https://github.com/mertdogar/super-line/tree/main/examples/react-chat-cluster) for the topology and what each tab shows.

Demonstrates: [React hooks](/guide/react), [scaling & adapters](/guide/scaling-adapters), [introspection & presence](/guide/introspection-and-presence).

## react-chat-cluster-libp2p — the same cluster, no broker

The same browser app and Control Center as `react-chat-cluster` above, but with **no Redis** — the two nodes peer directly over libp2p gossipsub via [`@super-line/adapter-libp2p`](/guide/adapter-libp2p). Same React SPA, same cross-node messages and cluster-wide (gossip-replicated) presence; the only structural change is the adapter line. Ports are offset (web `:8090`, Control Center `:8091`) so it runs alongside the Redis variant. Needs Docker.

```bash
cd examples/react-chat-cluster-libp2p && docker compose up --build
```

Demonstrates: [React hooks](/guide/react), [scaling & adapters](/guide/adapter-libp2p), [introspection & presence](/guide/introspection-and-presence).

## react-chat-cluster-rabbitmq — the same cluster over RabbitMQ

[`react-chat-cluster`](#react-chat-cluster-the-browser-app-across-two-servers) with **RabbitMQ** as the broker (via [`@super-line/adapter-rabbitmq`](/guide/adapter-rabbitmq)) instead of Redis — same React SPA, same Control Center. A single Caddy serves the SPA and `round_robin`s `/ws` across two nodes; messages cross process boundaries through the broker, and the cluster-wide online count comes from the adapter's **gossip-replicated** presence directory (eventually consistent — RabbitMQ has no shared key-value store). The only structural change from the Redis variant is the (async) adapter line. Ports are offset so all three cluster variants run at once. Needs Docker.

```bash
cd examples/react-chat-cluster-rabbitmq && docker compose up --build
```

App at `http://localhost:8100`, Control Center at `http://localhost:8101`; RabbitMQ management UI at `http://localhost:15673`.

Demonstrates: [React hooks](/guide/react), [the RabbitMQ adapter](/guide/adapter-rabbitmq), [introspection & presence](/guide/introspection-and-presence).

## react-chat-cluster-zeromq — delete your broker

[`react-chat-cluster`](#react-chat-cluster-the-browser-app-across-two-servers) with **Redis deleted** — same React app, same Control Center, same behavior, but **no broker service** in the stack. Three nodes peer directly over a [ZeroMQ](https://zeromq.org) mesh (via [`@super-line/adapter-zeromq`](/guide/adapter-zeromq)), so a message typed in a tab on node-1 still reaches a tab on node-3. The only code change is the adapter line; discovery is just DNS names on the compose network. The Control Center is the best way to *see* the brokerless mesh — no broker box in the topology, the three nodes peering directly. Needs Docker.

```bash
cd examples/react-chat-cluster-zeromq && docker compose up --build
```

App at `http://localhost:8080`, Control Center at `http://localhost:8081`.

Demonstrates: [React hooks](/guide/react), [the ZeroMQ adapter](/guide/adapter-zeromq), [introspection & presence](/guide/introspection-and-presence).

## libp2p-nat — servers behind NAT, browsers over WebRTC

A chat cluster where the **servers aren't directly reachable** — their libp2p nodes advertise *only* a `/p2p-circuit` reservation and `/webrtc`. Browser clients, sitting outside the network entirely, reach them over **WebRTC**, signalled through one small public relay that also lets the servers discover and mesh with each other. One libp2p node per server feeds both the libp2p **transport** (browser↔server) and the libp2p **adapter** (server↔server); STUN (`src/ice.ts`) is what lets WebRTC cross real NATs (a phone on cellular reaching a server behind a home router). Reuses the [`react-chat-cluster-libp2p`](#react-chat-cluster-libp2p-the-same-cluster-no-broker) contract and UI nearly unchanged — only the connectivity differs. Needs Docker.

```bash
cd examples/libp2p-nat && docker compose up --build
```

Chat at `http://localhost:8080`, Control Center at `http://localhost:8091`.

Demonstrates: [the libp2p transport](/guide/transport-libp2p), [the libp2p adapter](/guide/adapter-libp2p), [scaling & adapters](/guide/scaling-adapters).
