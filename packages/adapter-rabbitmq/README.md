# @super-line/adapter-rabbitmq

RabbitMQ adapter for [**super-line**](https://mertdogar.github.io/super-line/) — fan out rooms, topics, and the cluster event bus (`server.publish` / `server.subscribe`) across multiple server processes, with the broker doing selective per-channel routing.

```bash
pnpm add @super-line/adapter-rabbitmq
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { createRabbitmqAdapter } from '@super-line/adapter-rabbitmq'
import { api } from './contract'

const srv = createSuperLineServer(api, {
  server,
  authenticate,
  adapter: await createRabbitmqAdapter('amqp://localhost:5672'),
})
```

Point every server process at the same RabbitMQ broker. Without an adapter, a single node uses the built-in in-memory adapter — add this only when you scale out. Channels become routing keys on one durable `direct` exchange; each node owns one exclusive, auto-delete queue and binds only the channels it has local members for. At-most-once delivery; built on `rabbitmq-client` (automatic reconnection + topology recovery).

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guide: [scaling & adapters](https://mertdogar.github.io/super-line/guide/scaling-adapters)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
