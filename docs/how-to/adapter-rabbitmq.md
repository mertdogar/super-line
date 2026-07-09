# RabbitMQ adapter

For teams already running RabbitMQ, or who want the broker to do **selective routing** — each node receives only the channels it actually has members for. Provided by `@super-line/adapter-rabbitmq`.

```bash
pnpm add @super-line/adapter-rabbitmq
```

## Setup

```ts
import { createRabbitmqAdapter } from '@super-line/adapter-rabbitmq'
import { webSocketServerTransport } from '@super-line/transport-websocket'

const adapter = await createRabbitmqAdapter('amqp://localhost:5672')
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  adapter,
})
```

The factory is **async** — it connects and declares its topology before returning a ready adapter.

## How it routes

Channels become routing keys on one durable `direct` exchange. Each node owns an exclusive, auto-delete queue and binds **only the channels it has local members for** — so the broker delivers each message only to the nodes that subscribed. Built on [`rabbitmq-client`](https://www.npmjs.com/package/rabbitmq-client), so a dropped connection auto-reconnects and the node's bindings are replayed.

## Behavior notes

- **Gossip-replicated presence** (eventually consistent, like libp2p): RabbitMQ has no shared key-value store, so presence rides the same exchange. A crashed node's connections clear after a liveness TTL (~30s by default, vs Redis's broker-enforced key expiry); a graceful shutdown clears promptly.
- **At-most-once delivery** (transient messages, no acks, no persistence).
- One caveat Redis doesn't have: AMQP **routing keys cap at 255 bytes**, so a channel name (embedding room / user / topic) longer than that is rejected with a clear error.

Run it: the [`scaling-rabbitmq`](https://github.com/mertdogar/super-line/tree/main/examples/scaling-rabbitmq) example boots the cluster with the management UI exposed, so you can watch the exchange, per-node queues, and bindings live.

Next: [ZeroMQ](/how-to/adapter-zeromq) · back to [Choose an adapter](/how-to/choose-an-adapter).
