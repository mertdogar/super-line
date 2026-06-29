# @super-line/client

The client for [**super-line**](https://mertdogar.github.io/super-line/) — the strictly-typed realtime data bus for TypeScript. Call requests, listen to events, subscribe to topics, and read/write synced state — with auto-reconnect and at-most-once delivery, over a pluggable transport.

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

## Synced state (stores)

Pass the client half of each Store the server configures under `stores`, keyed by the same name. `client.store(name).open(id)` returns a reactive `ResourceHandle`: read `getSnapshot()`, `subscribe` to local writes + remote merges, and `set`/`update`/`delete(path)` to mutate the local replica and write the Change through to the server.

```ts
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { memoryStoreClient } from '@super-line/store-memory'

const client = createSuperLineClient(api, {
  transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
  role: 'user',
  stores: { scene: memoryStoreClient() }, // names must match the server's `stores`
})

const scene = client.store('scene').open('room-1')
await scene.ready                              // catch-up snapshot applied

scene.subscribe(() => render(scene.getSnapshot()))
scene.set({ title: 'untitled' })               // replace (LWW) or mutate the doc (CRDT)
scene.update({ title: 'hello' })               // merge a partial
scene.delete(['title'])                        // surgically remove one key
scene.close()
```

`delete(path)` removes the value at `path` (a key removal that merges, unlike a full-doc `set`). When another node deletes the whole Resource, the server fans the delete out cluster-wide (`sdel`): a `subscribe` callback fires and `scene.deleted` flips to `true` — re-read it alongside the snapshot. Store data is off-contract (untyped); writes rejected by the server surface through the client's `onStoreError`. One-shot `read(id)` / `write(id, data)` are also available on `client.store(name)`.

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guides: [requests](https://mertdogar.github.io/super-line/guide/requests), [reconnection & delivery](https://mertdogar.github.io/super-line/guide/reconnection-delivery)
- 📕 API reference: <https://mertdogar.github.io/super-line/reference/>
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
