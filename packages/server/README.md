# @super-line/server

The server for [**super-line**](https://mertdogar.github.io/super-line/) — the strictly-typed realtime data bus for TypeScript. Implements a shared contract over any transport: role-keyed request handlers, rooms, topics, synced state, middleware, lifecycle hooks, and node-to-node messaging. WebSocket is the default wire; HTTP/SSE, libp2p, and loopback are alternatives.

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

Cross-node fan-out (rooms, topics, the bus, targeted `toConn`/`toUser`, and store changes) rides a pluggable `adapter`. Defaults to an in-memory adapter (single process); for a cluster pass one of [`adapter-redis`](https://www.npmjs.com/package/@super-line/adapter-redis), [`adapter-libp2p`](https://www.npmjs.com/package/@super-line/adapter-libp2p), [`adapter-rabbitmq`](https://www.npmjs.com/package/@super-line/adapter-rabbitmq), or [`adapter-zeromq`](https://www.npmjs.com/package/@super-line/adapter-zeromq).

### Synced state (stores)

Pass server-side `stores` and the server becomes authoritative over persisted, reactive Resources — clients open the matching client halves. The store decides the consistency model (LWW or CRDT), durability (in-memory / SQLite / libsql / Postgres), and clustering (`relay` fans out over the adapter; `self` owns a central backend + per-node replica, no adapter). The default pair is [`@super-line/store-memory`](https://www.npmjs.com/package/@super-line/store-memory) (LWW · in-memory · relay).

```ts
import { memoryStoreServer } from '@super-line/store-memory'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  stores: { docs: memoryStoreServer() },
})

const docs = srv.store('docs') // ServerStoreHandle — throws NOT_FOUND if unconfigured
await docs.create('intro', { title: 'Hi' }, { 'user:1': { read: true, write: true } })
await docs.grant('intro', 'user:2', { read: true })
await docs.write('intro', { title: 'Updated' }) // LWW co-write, fanned out with a `server` origin
await docs.delete('intro') // publishes a cluster-wide deletion (sdel) to every subscriber
```

`ServerStoreHandle`: `create` / `read` / `write` / `grant` / `revoke` / `delete` / `list`. For a reactive in-process co-writer, `open(id)` returns a `ServerReplica` — the server half's mirror of the client's `store(ns).open(id)`:

```ts
const replica = srv.store('docs').open('intro', { origin: 'agent' })
replica.subscribe(() => console.log(replica.getSnapshot()))
replica.update({ title: 'Live' }) // merge
replica.delete('title')           // surgical key delete (the only way to remove a key server-side)
replica.close()
```

`open` requires a store with reactive support (throws `UNSUPPORTED` otherwise). CRDT stores (`store-sync`, `store-sync-libsql`, `store-sync-pglite`) and the LWW stores both back it.

### Control Center inspector

Mount `plugins: [inspector()]` (from [`@super-line/plugin-inspector`](https://www.npmjs.com/package/@super-line/plugin-inspector); `inspector({ redact: ['password', 'token'] })` to mask fields) to emit `msg.*` telemetry and accept read-only [Control Center](https://www.npmjs.com/package/@super-line/control-center) clients. The plugin declares the reserved connection class the WS transport negotiates. **Default off; dev / trusted-network only.**

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guides: [roles & auth](https://mertdogar.github.io/super-line/guide/roles-auth), [events & rooms](https://mertdogar.github.io/super-line/guide/events-rooms)
- 📕 API reference: <https://mertdogar.github.io/super-line/reference/>
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
