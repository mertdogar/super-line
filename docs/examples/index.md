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

## hono — one server for HTTP + WebSockets

super-line attached to a [Hono](https://hono.dev) app (`@hono/node-server`) on **one process, one port**: Hono serves the built frontend and REST routes while super-line owns the WebSocket bus, both on the same Node `http.Server` (the `{ server }` option — no library changes). Three live cards — a server-uptime [topic](/guide/topics), shared todos (req/res + a topic), and shared cursors whose identity is assigned server-side into `ctx` — plus a `POST /api/todos` **REST→WS bridge**: `curl` a todo in and watch it appear in every open tab. The bridge route and the WS upgrade share one auth rule. Open a few tabs and move your mouse.

```bash
pnpm --filter @super-line/example-hono build
pnpm --filter @super-line/example-hono start   # http://localhost:3000
```

Demonstrates: [topics](/guide/topics), [requests](/guide/requests), [middleware & lifecycle](/guide/middleware-lifecycle), composing with an HTTP framework.

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

One process shows the [cluster event bus](/guide/scaling-adapters#the-cluster-event-bus) on a shared topic: a `server.publish` fans out to several in-process `server.subscribe` listeners (showing local echo — your own publish fires in-process, no round-trip) plus one client subscriber over WS. No Redis needed.

```bash
pnpm --filter @super-line/example-event-bus start
```

Demonstrates: [the cluster event bus](/guide/scaling-adapters#the-cluster-event-bus).

## bus-cluster — multi-node server.subscribe showcase

A cluster via Docker Compose: **Redis + Caddy + 3 server nodes + watcher clients**. Every node bumps a counter and `server.subscribe`s to every node's bumps, converging a shared tally — own bumps land in-process via local echo, peers' arrive over Redis. node-1 publishes a client-facing `total` snapshot. Needs Docker.

```bash
cd examples/bus-cluster && docker compose up
```

Demonstrates: [the cluster event bus](/guide/scaling-adapters#the-cluster-event-bus), [scaling & adapters](/guide/scaling-adapters).

## scaling — a real multi-node cluster

A genuine cluster via Docker Compose: **Redis + a Caddy load balancer + 3 server nodes + 6 client containers**. Caddy round-robins each client onto a node; you watch room broadcasts, a topic, and `stats` gossip — migrated to a shared `stats` topic over the cluster event bus — fan out across separate processes. Needs Docker.

```bash
cd examples/scaling && docker compose up
```

See [`examples/scaling/README.md`](https://github.com/mertdogar/super-line/tree/main/examples/scaling) for what to watch, how to connect your own client to the load balancer, and `--scale`.

Demonstrates: [scaling & adapters](/guide/scaling-adapters), [the cluster event bus](/guide/scaling-adapters#the-cluster-event-bus).

## react-chat-cluster — the browser app, across two servers

[`react-chat`](#react-chat-browser-app) behind a real cluster via Docker Compose: **Redis + 2 server nodes + a Caddy** that serves the built SPA *and* round-robins `/ws` across the nodes. Open `http://localhost:8080` in several tabs — each lands on a different node (shown in the header), yet messages cross servers via a `room.broadcast` over the Redis adapter, and the online count is cluster-wide via `cluster.room(...)`. Needs Docker.

```bash
cd examples/react-chat-cluster && docker compose up
```

See [`examples/react-chat-cluster/README.md`](https://github.com/mertdogar/super-line/tree/main/examples/react-chat-cluster) for the topology and what each tab shows.

Demonstrates: [React hooks](/guide/react), [scaling & adapters](/guide/scaling-adapters), [introspection & presence](/guide/introspection-and-presence).

## react-chat-cluster-libp2p — the same cluster, no broker

The same browser app and Control Center as `react-chat-cluster` above, but with **no Redis** — the two nodes peer directly over libp2p gossipsub via [`@super-line/adapter-libp2p`](/guide/scaling-adapters#decentralized-libp2p-no-broker). Same React SPA, same cross-node messages and cluster-wide (gossip-replicated) presence; the only structural change is the adapter line. Ports are offset (web `:8090`, Control Center `:8091`) so it runs alongside the Redis variant. Needs Docker.

```bash
cd examples/react-chat-cluster-libp2p && docker compose up --build
```

Demonstrates: [React hooks](/guide/react), [scaling & adapters](/guide/scaling-adapters#decentralized-libp2p-no-broker), [introspection & presence](/guide/introspection-and-presence).
