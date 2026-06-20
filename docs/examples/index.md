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
