# Choose your backbone

A single super-line server uses an in-memory adapter — rooms and topics fan out within that one process. To run **more than one process** (behind a load balancer), give every server a **shared adapter** so fan-out crosses nodes.

The adapter is the *server↔server* axis. (The *client↔server* wire is the separate, independent [transport](./transports) axis — you pick each on its own.)

## The adapter seam

Rooms, topics, and the [cluster event bus](./cluster-event-bus) all compile down to channel pub/sub behind the `Adapter` interface. Swap the implementation; the rest of your code is unchanged — only the `adapter:` line differs:

```ts
import { createRedisAdapter } from '@super-line/adapter-redis'
import { webSocketServerTransport } from '@super-line/transport-websocket'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  adapter: createRedisAdapter('redis://localhost:6379'), // ← the only line that changes
})
```

Point every server process at the same backbone, and `room.broadcast`, `srv.publish` / `forRole(r).publish`, and the cluster bus all reach clients (and peers) on **any** node. At-most-once delivery is preserved.

::: tip No adapter for a single node
You don't need an adapter for one process — the default in-memory adapter handles it. Add a backbone only when you scale out.
:::

## Which adapter?

| Adapter | Reach for it when… | Presence | Shape |
|---|---|---|---|
| **[Redis](./adapter-redis)** | the pragmatic default for a backend cluster | strong, central | one central broker, broker-enforced expiry |
| **[RabbitMQ](./adapter-rabbitmq)** | you already run it, or want **selective** per-channel routing | gossip (eventual) | broker delivers only subscribed channels |
| **[ZeroMQ](./adapter-zeromq)** | you want the **lightest** broker-less option | gossip (eventual) | direct sockets; mesh O(N²) or proxy mode |
| **[libp2p](./adapter-libp2p)** | decentralized **self-hosted / edge** | gossip (eventual) | NAT traversal, encrypted, discovery; ESM-only |

All four implement the same `Adapter` seam, so switching is a one-line change. **Redis** is the default; the three broker-less options trade central presence for one fewer service to run.

## Running it

The [`scaling` example](https://github.com/mertdogar/super-line/tree/main/examples/scaling) boots a real cluster with Docker Compose — Redis, a Caddy load balancer, three server nodes, and six client containers — so you can watch a publish, a room broadcast, and a shared `stats` topic gossiped over the bus fan out across separate processes:

```bash
cd examples/scaling && docker compose up
```

Each broker-less adapter ships the same cluster with the broker swapped out: [`scaling-libp2p`](https://github.com/mertdogar/super-line/tree/main/examples/scaling-libp2p), [`scaling-rabbitmq`](https://github.com/mertdogar/super-line/tree/main/examples/scaling-rabbitmq), and the `react-chat-cluster-*` variants.

Next: pick a backbone — [Redis](./adapter-redis) · [libp2p](./adapter-libp2p) · [RabbitMQ](./adapter-rabbitmq) · [ZeroMQ](./adapter-zeromq).
