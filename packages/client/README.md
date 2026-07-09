# @super-line/client

The client for [**super-line**](https://super-line.dogar.biz/) — the strictly-typed realtime data bus for TypeScript. Call requests, listen to events, subscribe to topics, and read/write synced state — with auto-reconnect and at-most-once delivery, over a pluggable transport.

```bash
pnpm add @super-line/core @super-line/client @super-line/transport-websocket zod
```

```ts
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { api } from './contract'

const client = createSuperLineClient(api, {
  transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
  role: 'user',
})

client.on('message', (m) => console.log(m.text))   // typed
const sub = client.subscribe('prices', (p) => render(p))
await sub.ready

const out = await client.send({ text: 'hi' })       // throws typed SuperLineError on failure
client.close()
```

The client is narrowed to its `role`'s surface (`shared ∪ role`). The wire is carried by a pluggable transport — [`@super-line/transport-websocket`](https://www.npmjs.com/package/@super-line/transport-websocket) provides the WS transport shown above; other transports (HTTP/SSE, libp2p) are available — see the Transports guide. Works in browsers and Node 22+ (pass `webSocketClientTransport({ url, WebSocket })` on older runtimes).

## Persisted state (collections)

[Collections](https://super-line.dogar.biz/collections/) are typed, contract-declared state the server syncs. `client.collection(name)` is typed by the contract — subscribe to a live, filtered **row-set**, or `open(id)` a CRDT **document** whose concurrent edits merge.

```ts
import { eq } from '@super-line/core'

const messages = client.collection('messages')
const sub = messages.subscribe({ filter: eq('channelId', 'general') })
await sub.ready                        // frames process concurrently — await before depending on live delivery
sub.rows()                             // current rows
sub.subscribe((ev) => { /* { type: 'insert' | 'update' | 'delete', id, row } */ })

await messages.insert({ id: 'm2', channelId: 'general', authorId: 'me', text: 'hi', createdAt: Date.now() })
```

Row writes are **non-optimistic** — a write lands in `rows()` once the server confirms it; for joins, live queries, and optimism, pair a collection with [TanStack DB](https://super-line.dogar.biz/collections/tanstack-db). For a collaborative document, pass `crdtCollections: crdtCollectionsClient()` and use `client.collection(name).open(id)` (`getSnapshot` / `subscribe` / `update`). See the [Collections guide](https://super-line.dogar.biz/collections/).

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guides: [requests](https://super-line.dogar.biz/how-to/requests), [reconnection & delivery](https://super-line.dogar.biz/concepts/reconnection-delivery)
- 📕 API reference: <https://super-line.dogar.biz/reference/>
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
