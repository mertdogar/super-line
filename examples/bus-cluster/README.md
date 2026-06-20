# bus-cluster — the cluster event bus across nodes

A genuine multi-node cluster — **Redis + a Caddy load balancer + 3 server nodes + watcher clients** — that showcases the **cluster event bus**: every node *reacts* to every node's events in its own process via `server.subscribe`, converging a shared tally. Unlike [`scaling`](../scaling) (which fans server messages out to *clients*), the star here is **server-to-server reactions**: nodes computing shared state from each other's events.

## Run it

```bash
cd examples/bus-cluster
docker compose up        # builds the image once, then boots the cluster
```

## What you'll see

Every node bumps a counter on a timer and **subscribes to every node's bumps** — including its own (local echo). Each node logs its converging view of the cluster-wide tally; clients watch the live total:

```
bus-cluster-node-1  | [node-1] bump node-1 (origin self)     → cluster total 4 { 'node-1': 2, 'node-2': 1, 'node-3': 1 }
bus-cluster-node-2  | [node-2] bump node-1 (origin a1b2c3d4) → cluster total 4 { 'node-1': 2, 'node-2': 1, 'node-3': 1 }
bus-cluster-client-1| bus-cluster-client-1 ← cluster total 6 { 'node-1': 2, 'node-2': 2, 'node-3': 2 }
```

- **`origin self`** — a node hearing its *own* bump. It arrives **in-process, with no Redis round-trip** (`server.publish` fires same-node `server.subscribe` listeners directly); only `meta.from === srv.nodeId`.
- **`origin a1b2c3d4`** — a peer's bump, fanned out over the shared Redis adapter; `meta.from` is the publishing node's id.
- The `total` snapshot (published by `node-1`) reaches **clients on any node** — a server-side aggregate, built purely from the bus, delivered over WebSockets.

## Scale it

```bash
docker compose up --scale client=8
```

## Stop

`Ctrl-C`, then `docker compose down`.

## How it maps to super-line

- `src/contract.ts` — one shared topic `bump` (the bus event every node publishes + subscribes) and a client-facing `total` snapshot.
- `src/server.ts` — one node. `srv.publish('bump', …)` on a timer, `srv.subscribe('bump', (b, { from }) => …)` to converge the tally (using `from` to tell self from peers), and (on `node-1`) `srv.publish('total', …)` for clients.
- `src/client.ts` — a watcher: subscribes to `total` and logs it.
- `Caddyfile` — `reverse_proxy` across the three nodes with `lb_policy round_robin`.
