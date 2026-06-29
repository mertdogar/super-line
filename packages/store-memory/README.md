# @super-line/store-memory

The **default**, zero-dependency in-memory **Store** for [**super-line**](https://mertdogar.github.io/super-line/) —
a permissioned, real-time JSON document store with last-writer-wins (LWW) semantics. This is the
reference Store pair; durable and self-clustering backends
([`store-sqlite`](https://www.npmjs.com/package/@super-line/store-sqlite),
[`store-sync-libsql`](https://www.npmjs.com/package/@super-line/store-sync-libsql),
[`store-pglite`](https://www.npmjs.com/package/@super-line/store-pglite)) match its API.

```bash
pnpm add @super-line/store-memory
```

A Store is **off-contract** — there's no schema in `defineContract` for the document `data`. You pass
the backend pair (the server half + the client half) to the server and client, and
read/write/subscribe methods appear on the instances. The server is authoritative: it creates
Resources, grants per-principal access, and can co-write at any time.

```ts
// server
import { createSuperLineServer } from '@super-line/server'
import { memoryStoreServer } from '@super-line/store-memory'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  stores: { docs: memoryStoreServer() },
})

await srv.store('docs').create('note-1', { title: 'Draft', body: '' }, { alice: { read: true, write: true } })
```

```ts
// client
import { createSuperLineClient } from '@super-line/client'
import { memoryStoreClient } from '@super-line/store-memory'

const client = createSuperLineClient(api, {
  transport: webSocketClientTransport({ url }),
  role: 'user',
  stores: { docs: memoryStoreClient() },
})

const doc = client.store('docs').open('note-1') // reactive handle: catch-up snapshot, then live changes
await doc.ready
doc.subscribe(() => console.log(doc.getSnapshot()))
doc.update({ title: 'Shipping plan' }) // fans out to every other open handle
```

## How it works

- **Model — LWW.** Each Resource is a single value cell; a write replaces the whole `data` and emits
  a full-value Change. The last write wins. For collaborative merge (Yjs/super-store CRDT) use
  [`@super-line/store-sync`](https://www.npmjs.com/package/@super-line/store-sync) instead.
- **Clustering — `relay`.** The store does no networking. super-line core relays its Changes across
  nodes over the server↔server [Adapter](https://mertdogar.github.io/super-line/guide/scaling-adapters)
  and feeds remote Changes back in, so opening the same Resource on any node stays in sync.
- **Server co-writer.** `srv.store(ns).open(id)` returns a `ServerReplica` with
  `set`/`update`/`delete(path)`; server writes fan out with a `server` origin.
- **Deletion fan-out.** `srv.store(ns).delete(id)` publishes a cluster-wide delete; the client
  `ResourceHandle.deleted` flag (and React `useResource().deleted`) flips to `true`.
- **In-memory.** Nothing persists across a restart — swap in a durable backend (sqlite/libsql/pglite)
  when you need that; they pair with this same client (or `syncStoreClient` for the CRDT ones).

## Options

| Function | Option | Meaning |
| --- | --- | --- |
| `memoryStoreServer()` | — | The server half. No options. |
| `memoryStoreClient(opts?)` | `origin` | A per-writer id used for echo-break. Defaults to a random id per client instance — only override it to share/control the origin. |

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guide: [stores](https://mertdogar.github.io/super-line/guide/store)
- 🧩 Example: [`store`](https://github.com/mertdogar/super-line/tree/main/examples/store)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
