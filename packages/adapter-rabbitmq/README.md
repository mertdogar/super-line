# @super-line/adapter-rabbitmq

RabbitMQ adapter for [**super-line**](https://super-line.dogar.biz/) — fan out rooms, topics, and the cluster event bus (`server.publish` / `server.subscribe`) across multiple server processes, with the broker doing selective per-channel routing.

```bash
pnpm add @super-line/core @super-line/adapter-rabbitmq
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { createRabbitmqAdapter } from '@super-line/adapter-rabbitmq'
import { api } from './contract'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  adapter: await createRabbitmqAdapter('amqp://localhost:5672'),
})
```

Point every server process at the same RabbitMQ broker. Without an adapter, a single node uses the built-in in-memory adapter — add this only when you scale out. At-most-once delivery; built on `rabbitmq-client` (automatic reconnection + topology recovery). `createRabbitmqAdapter` takes an `amqp://` URL string or an options object.

## How it works

- **Fan-out** — channels become routing keys on one durable `direct` exchange. Each node owns one exclusive, auto-delete queue and binds only the channels it has local members for, so the broker routes selectively — a node never receives traffic it didn't subscribe to.
- **Presence** — a gossip directory under the reserved `sl.presence` routing key (deltas + periodic snapshots, heartbeat/TTL liveness) powers `srv.cluster.*` / `srv.isOnline`. On by default; pass `presence: false` to disable.
- **Reconnect** — the desired subscription set is replayed (queue + bindings re-declared) after every reconnect, so a dropped broker connection self-heals.
- **Routing-key limit** — AMQP routing keys cap at 255 bytes and channels embed room / topic / userId, so an over-long channel throws an honest error rather than an opaque encoder failure.

## Options

| Option | Meaning |
| --- | --- |
| `url` | `amqp://` (or `amqps://`) connection URL — the simple case. |
| `connection` | Bring your own `rabbitmq-client` `Connection` (TLS, multi-host failover, custom heartbeat/vhost). The adapter won't close a connection it didn't create. |
| `exchange` | The shared durable `direct` exchange (default `'super-line'`). |
| `queuePrefix` | Prefix for this node's exclusive queue, `<prefix>.<uuid>` (default `'sl.node'`). |
| `presence` | `false` to disable, or `{ snapshotIntervalMs, livenessTtlMs }` to tune. |

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [scaling & adapters](https://super-line.dogar.biz/how-to/choose-an-adapter)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
