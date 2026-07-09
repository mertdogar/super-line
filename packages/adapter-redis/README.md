# @super-line/adapter-redis

Redis Pub/Sub adapter for [**super-line**](https://super-line.dogar.biz/) — fan out rooms, topics, and the cluster event bus (`server.publish` / `server.subscribe`) across multiple server processes.

```bash
pnpm add @super-line/adapter-redis
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { createRedisAdapter } from '@super-line/adapter-redis'
import { api } from './contract'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  adapter: createRedisAdapter('redis://localhost:6379'),
})
```

Point every server process at the same Redis. Without an adapter, a single node uses the built-in in-memory adapter — add this only when you scale out. At-most-once delivery; uses two connections (a subscriber connection can't run other commands).

Collection changes ride the same bus — a `relay` collection backend's writes and deletes on one node fan out over Redis so every node converges and every subscribed client updates.

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [scaling & adapters](https://super-line.dogar.biz/how-to/choose-an-adapter)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
