# Redis adapter

The pragmatic default for a backend cluster: a central Redis every node points at. Simple, the strongest presence of any adapter, at-most-once delivery. Provided by `@super-line/adapter-redis`.

```bash
pnpm add @super-line/adapter-redis
```

## Setup

Point every server process at the **same** Redis and pass the adapter — nothing else in your code changes:

```ts
import { createRedisAdapter } from '@super-line/adapter-redis'
import { webSocketServerTransport } from '@super-line/transport-websocket'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  adapter: createRedisAdapter('redis://localhost:6379'), // ← the only line that changes
})
```

Now `room.broadcast`, `srv.publish` / `forRole(r).publish`, and the [cluster event bus](/how-to/cluster-event-bus) reach clients (and peers) on **any** node.

## Behavior notes

- **Strong, central presence.** `srv.cluster.*` / `srv.isOnline` are backed by Redis keys with **broker-enforced expiry** — a crashed node's connections clear on TTL, and a graceful shutdown clears promptly. This is the most authoritative presence of any adapter.
- **At-most-once delivery**, matching the rest of the library (transient pub/sub, no replay).
- One central service to run and coordinate — when you'd rather go broker-less, see [libp2p](/how-to/adapter-libp2p) or [ZeroMQ](/how-to/adapter-zeromq).

::: tip No adapter for a single node
One process uses the default in-memory adapter — add Redis only when you scale out behind a load balancer.
:::

Run it: the [`scaling`](https://github.com/mertdogar/super-line/tree/main/examples/scaling), [`react-chat-cluster`](https://github.com/mertdogar/super-line/tree/main/examples/react-chat-cluster), and [`bus-cluster`](https://github.com/mertdogar/super-line/tree/main/examples/bus-cluster) examples all run on Redis.

Next: [libp2p](/how-to/adapter-libp2p) · back to [Choose an adapter](/how-to/choose-an-adapter).
