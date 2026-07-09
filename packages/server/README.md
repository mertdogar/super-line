# @super-line/server

The server for [**super-line**](https://super-line.dogar.biz/) — the strictly-typed realtime data bus for TypeScript. Implements a shared contract over any transport: role-keyed request handlers, rooms, topics, synced state, middleware, lifecycle hooks, and node-to-node messaging. WebSocket is the default wire; HTTP/SSE, libp2p, and loopback are alternatives.

```bash
pnpm add @super-line/core @super-line/server @super-line/transport-websocket zod
```

```ts
import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { api } from './contract'

const server = http.createServer()
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate: (h) => ({ role: 'user' as const, ctx: { id: '1' } }), // throw -> 401
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

Authenticate receives the `Handshake` (`{ transport, headers, query, peer?, raw }`) and returns `{ role, ctx }`; cross-role calls are rejected with `NOT_FOUND`. The wire is carried by a pluggable transport — [`@super-line/transport-websocket`](https://www.npmjs.com/package/@super-line/transport-websocket) provides the WS transport shown above; HTTP/SSE ([`transport-http`](https://www.npmjs.com/package/@super-line/transport-http)), libp2p ([`transport-libp2p`](https://www.npmjs.com/package/@super-line/transport-libp2p)), and in-memory ([`transport-loopback`](https://www.npmjs.com/package/@super-line/transport-loopback)) are alternatives — see the Transports guide.

### Cluster event bus

`srv.publish(topic, data)` / `srv.subscribe(topic, handler)` is a server-side pub/sub over a shared contract topic. The callback fires for a publish from any node — including this one (local echo, in-process, no round-trip). `meta.from` is the publishing node; self-exclude with `if (meta.from === srv.nodeId) return`.

```ts
const off = srv.subscribe('orders', (order, meta) => {
  if (meta.from === srv.nodeId) return // skip our own echo
  // react to an order published on another node
})
srv.publish('orders', { id: '...', total: 42 })
```

Cross-node fan-out (rooms, topics, the bus, targeted `toConn`/`toUser`, and collection changes) rides a pluggable `adapter`. Defaults to an in-memory adapter (single process); for a cluster pass one of [`adapter-redis`](https://www.npmjs.com/package/@super-line/adapter-redis), [`adapter-libp2p`](https://www.npmjs.com/package/@super-line/adapter-libp2p), [`adapter-rabbitmq`](https://www.npmjs.com/package/@super-line/adapter-rabbitmq), or [`adapter-zeromq`](https://www.npmjs.com/package/@super-line/adapter-zeromq).

### Persisted state (collections)

Declare `collections` on the contract and give the server a backend — it becomes the server-authoritative **sync source**, validating every write against the schema and enforcing per-collection policies (**deny-by-default**). Two consistency models: typed **rows** (LWW) and CRDT **documents**.

```ts
import { memoryCollections } from '@super-line/collections-memory'
import { isIn } from '@super-line/core'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  identify: (conn) => conn.ctx.userId,           // the principal every policy sees
  collections: memoryCollections(),              // one backend serves every row collection
  policies: {
    messages: {
      read: (_principal, ctx) => isIn('channelId', ctx.channels), // a filter, ANDed into every read
      write: (principal, op, next, prev) =>                        // per-op guard
        op === 'delete' ? prev?.authorId === principal : next?.authorId === principal,
    },
  },
})

// server co-writes bypass policy (trusted) but are still schema-validated
await srv.collection('messages').insert({ id: 'm1', channelId: 'general', authorId: 'system', text: 'welcome', createdAt: Date.now() })
```

For collaborative documents, add a CRDT backend (`crdtCollections: crdtMemoryCollections()`) with a guard-shaped policy. Creation is server-authoritative (`srv.collection('scenes').create(id, data)`), and `open(id)` returns a reactive in-process co-writer (`getSnapshot` / `subscribe` / `update`). See the [Collections guide](https://super-line.dogar.biz/collections/).

### Control Center inspector

Mount `plugins: [inspector()]` (from [`@super-line/plugin-inspector`](https://www.npmjs.com/package/@super-line/plugin-inspector); `inspector({ redact: ['password', 'token'] })` to mask fields) to emit `msg.*` telemetry and accept read-only [Control Center](https://www.npmjs.com/package/@super-line/control-center) clients. The plugin declares the reserved connection class the WS transport negotiates. **Default off; dev / trusted-network only.**

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guides: [roles & auth](https://super-line.dogar.biz/how-to/roles-auth), [events & rooms](https://super-line.dogar.biz/how-to/events-rooms)
- 📕 API reference: <https://super-line.dogar.biz/reference/>
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
