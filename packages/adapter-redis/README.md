# @super-line/adapter-redis

Redis Pub/Sub adapter for [**super-line**](https://mertdogar.github.io/super-line/) — fan out rooms, topics, and the cluster event bus (`server.publish` / `server.subscribe`) across multiple server processes.

```bash
pnpm add @super-line/adapter-redis
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { createRedisAdapter } from '@super-line/adapter-redis'
import { api } from './contract'

const srv = createSuperLineServer(api, {
  server,
  authenticate,
  adapter: createRedisAdapter('redis://localhost:6379'),
})
```

Point every server process at the same Redis. Without an adapter, a single node uses the built-in in-memory adapter — add this only when you scale out. At-most-once delivery; uses two connections (a subscriber connection can't run other commands).

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guide: [scaling & adapters](https://mertdogar.github.io/super-line/guide/scaling-adapters)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
