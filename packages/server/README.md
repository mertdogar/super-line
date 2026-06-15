# @super-line/server

The server for [**super-line**](https://mertdogar.github.io/super-line/) — end-to-end typesafe WebSockets for TypeScript. Implements a shared contract over [`ws`](https://www.npmjs.com/package/ws): role-keyed handlers, rooms, topics, middleware, lifecycle hooks, and node-to-node messaging.

```bash
pnpm add @super-line/core @super-line/server zod
```

```ts
import http from 'node:http'
import { createSocketServer } from '@super-line/server'
import { api } from './contract'

const server = http.createServer()
const srv = createSocketServer(api, {
  server,
  authenticate: (req) => ({ role: 'user' as const, ctx: { id: '1' } }), // throw -> 401
})

srv.implement({
  user: {
    send: async ({ text }, ctx, conn) => {
      conn.emit('message', { text })
      return { id: crypto.randomUUID() }
    },
  },
})

server.listen(3000)
```

Authenticate returns `{ role, ctx }`; cross-role calls are rejected with `NOT_FOUND`. Scale across processes with [`@super-line/adapter-redis`](https://www.npmjs.com/package/@super-line/adapter-redis).

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guides: [roles & auth](https://mertdogar.github.io/super-line/guide/roles-auth), [events & rooms](https://mertdogar.github.io/super-line/guide/events-rooms)
- 📕 API reference: <https://mertdogar.github.io/super-line/reference/>
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
