# react-chat-cluster-rabbitmq — chat across two servers over RabbitMQ

The [`react-chat-cluster`](../react-chat-cluster) example runs the same chat behind two nodes using
a **Redis** broker. This one is identical — same React SPA, same Control Center — but with
**RabbitMQ** as the substrate via [`@super-line/adapter-rabbitmq`](../../packages/adapter-rabbitmq).
Open the app in several tabs, watch each land on a *different* server, and chat between them — every
message crossing process boundaries through the broker.

A single **Caddy** container serves the built React SPA *and* reverse-proxies the WebSocket,
`round_robin`-ing each connection across the nodes:

```
browser :8100 ── web (Caddy) ┬─ GET /    → the vite-built SPA
                             └─ WS  /ws  → round_robin → node-1 / node-2
                                                          └─ RabbitMQ direct exchange ─┘
                                                               (broker-routed fan-out)
```

## Run it

```bash
cd examples/react-chat-cluster-rabbitmq
docker compose up --build   # boots RabbitMQ + 2 nodes + web + the Control Center
```

> Use `--build`. The node image bakes the TypeScript source in at build time, so without it
> `docker compose up` silently reuses a stale image. Unchanged layers are cached, so a no-op
> rebuild is fast.

Open <http://localhost:8100> in **two or more tabs** (same browser is fine). Pick a name in each,
join the same room. (Ports are offset from the Redis and libp2p variants, so all three can run at
once.) The RabbitMQ management UI is at <http://localhost:15673> (`superline` / `superline`) — watch
the `super-line` exchange, the per-node exclusive queues, and their bindings appear live.

## Inspect it with the Control Center

`docker compose up` also boots the [Control Center](../../packages/control-center) at
<http://localhost:8101> — a live view of this exact cluster:

- the **topology** graph — `node-1`, `node-2`, and the adapter bus, with each chat tab's connection
  hanging off the node it landed on;
- the **live feed** — lifecycle events *and* the actual message traffic (`join`, the `message`
  broadcast, the `presence` publish) as they cross nodes through the broker in real time;
- the **contract** explorer and a per-connection drawer.

The nodes run with `plugins: [inspector()]` (from `@super-line/plugin-inspector`), and Caddy pins
`/inspect` to **node-1**, so node-1's connections show their live `ctx` (the chat `name`) while
node-2's show the cross-node `ctxAvailable: false` boundary — node-local `ctx` never leaves its
node.

> The inspector channel is **read-only but unauthenticated** (dev/trusted-network only). The
> inspector rides the WebSocket, not the adapter, so it works identically over RabbitMQ.

## What you'll see

- **Each tab shows its node** in the header; `round_robin` puts the first two tabs on different servers.
- **Messages cross servers** through RabbitMQ — type in the node-1 tab, it appears in the node-2 tab
  tagged `ada@node-1`.
- **The online count is cluster-wide**, from the adapter's gossip-replicated presence directory
  (`srv.cluster.room(room)`).

> Presence here is **eventually consistent** — RabbitMQ has no shared key-value store, so the adapter
> replicates presence by gossip (deltas + periodic snapshots over the same exchange) rather than a
> central store, exactly like the libp2p variant. A cross-node count can lag by a fraction of a second
> under churn before it settles. A tab is bound to its node for the life of its WebSocket; reload to
> re-sync after a reconnect.

## Stop

`Ctrl-C`, then `docker compose down`.

## How it maps to super-line

The **only** structural change from [`react-chat-cluster`](../react-chat-cluster) is the adapter:
`createRedisAdapter(REDIS_URL)` becomes `await createRabbitmqAdapter(RABBITMQ_URL)` (the RabbitMQ
factory is async — it connects and declares its topology before returning a ready adapter). The
contract, the React SPA, the Control Center, presence, and the inspector are all unchanged — the
`Adapter` seam is what makes the swap a one-liner.
