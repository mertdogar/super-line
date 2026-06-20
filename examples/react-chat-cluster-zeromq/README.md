# react-chat-cluster-zeromq — delete your broker

This is [`react-chat-cluster`](../react-chat-cluster) with **Redis deleted**. Exact same React
app, same Control Center, same behavior — but there is **no broker service** in the stack. The
three chat nodes peer directly over a [ZeroMQ](https://zeromq.org) mesh, so a message typed in a
tab on `node-1` still reaches a tab on `node-3`.

```
 react-chat-cluster (Redis)            react-chat-cluster-zeromq (mesh)
 ───────────────────────────          ─────────────────────────────────
 node-1 ─┐                             node-1 ─┬─ node-2
         ├─ redis  ← a service          (mesh) ├─ node-3      ← no broker,
 node-2 ─┘                             node-2 ─┴─ node-3        nodes peer directly
```

The only code change is the adapter line in `src/server.ts`:

```diff
- import { createRedisAdapter } from '@super-line/adapter-redis'
- adapter: createRedisAdapter(REDIS_URL),
+ import { createZeroMqAdapter } from '@super-line/adapter-zeromq'
+ adapter: await createZeroMqAdapter({ bind: ZMQ_BIND, peers: ZMQ_PEERS }),
```

…and `docker-compose.yml` loses its `redis` service (and its healthcheck/`depends_on`). Each node
gets `ZMQ_BIND` + a comma-separated `ZMQ_PEERS` list of the other nodes — discovery is just DNS
names on the compose network, no broker, no registry.

## Run it

```bash
cd examples/react-chat-cluster-zeromq
docker compose up --build   # boots 3 nodes + web + the Control Center — and NO broker
```

> Use `--build`. The node image bakes the TypeScript source in at build time. `zeromq` is a
> native addon — pnpm fetches its prebuilt binary for the image platform during install.

Open <http://localhost:8080> in **two or more tabs** (same browser is fine). Pick a name in each,
join the same room.

## Inspect it with the Control Center

`docker compose up` also boots the [Control Center](../../packages/control-center) at
<http://localhost:8081> — a live view of this exact cluster, and the best way to *see* the
brokerless mesh working:

- the **topology** graph — `node-1`, `node-2`, `node-3` peering directly (no broker box in the
  picture), with each chat tab's connection hanging off the node it landed on;
- the **live feed** — lifecycle events (`connect` / `room.add` / `disconnect`) *and* the actual
  message traffic (`join` requests + responses, the `message` room broadcast, the `presence` topic
  publish) crossing nodes in real time. Filter by Lifecycle / Requests / Events, pause to freeze,
  click any row to expand its payload;
- the **contract** explorer and a per-connection drawer.

The nodes run with `inspector: true`, and Caddy pins `/inspect` to **node-1**, so node-1's
connections show their live `ctx` (the chat `name`) while other nodes' connections show the
cross-node `ctxAvailable: false` boundary — node-local `ctx` never leaves its node.

## What you'll see

- **Each tab shows its node** in the header. `round_robin` spreads tabs across `node-1`/`2`/`3`.
- **Messages cross servers with no broker.** Type in the node-1 tab; it appears in the node-3 tab,
  tagged `ada@node-1`. The send is a `room.broadcast` the ZeroMQ mesh fans out to every node.
- **The online count is cluster-wide** — from the adapter's gossip presence directory
  (`srv.cluster.room(room).length`), so a third tab ticks every tab to `3 online`.

## Mesh vs. forwarder

This example uses **mesh** mode — gorgeous at three nodes (no infra at all), O(N²) connections
with a static peer list. For a larger or dynamic fleet, run a central forwarder instead:
`npx super-line-zeromq-proxy`, then `createZeroMqAdapter({ mode: 'proxy', frontendUrl, backendUrl })`.
See the [scaling & adapters guide](https://mertdogar.github.io/super-line/guide/scaling-adapters).

## Stop

`Ctrl-C`, then `docker compose down`.
