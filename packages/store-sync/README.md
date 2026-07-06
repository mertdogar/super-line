# @super-line/store-sync

CRDT [Store](https://mertdogar.github.io/super-line/guide/store) for
[**super-line**](https://mertdogar.github.io/super-line/), backed by
[super-store](https://github.com/mertdogar/super-store) (Yjs) — a merging,
real-time collaborative persisted-state pair. Concurrent writes to **different
fields converge** instead of clobbering, the failure mode of a last-writer-wins
store like [`@super-line/store-memory`](https://www.npmjs.com/package/@super-line/store-memory).

```bash
pnpm add @super-line/store-sync
```

```ts
// server
import { createSuperLineServer } from '@super-line/server'
import { syncStoreServer } from '@super-line/store-sync'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  stores: { docs: syncStoreServer() },
})
```

```ts
// client (or React, via createSuperLineHooks → useResource('docs', id))
import { createSuperLineClient } from '@super-line/client'
import { syncStoreClient } from '@super-line/store-sync'

const client = createSuperLineClient(api, {
  transport,
  stores: { docs: syncStoreClient() },
})
```

Each opened Resource is a reactive document: local writes produce a delta, remote
deltas merge in. Two clients editing different fields at the same time both keep
their changes.

## How it works

- **CRDT merge** — every Resource is a super-store `StoreValue` (a Yjs doc root).
  super-store does the merge work; super-line just moves bytes and maps origins.
- **Opaque wire delta** — the `update` on the wire is a base64 Yjs delta. super-line
  relays it without parsing, so the wire stays contract-typed and the CRDT stays a
  black box to the bus.
- **`clustering: 'relay'`** — replicas converge across nodes via super-line's
  server↔server [Adapter](https://mertdogar.github.io/super-line/guide/scaling-adapters)
  fan-out. Storage is **in-memory** — for durability use the self-clustering
  [`store-sync-pglite`](https://www.npmjs.com/package/@super-line/store-sync-pglite)
  (Postgres), or the durable-`relay`
  [`collections-crdt-libsql`](https://www.npmjs.com/package/@super-line/collections-crdt-libsql)
  (Turso/sqld) — the CRDT doc-store family has folded into collections (ADR-0007).
- **Deletion fan-out** — `srv.store('docs').delete(id)` publishes a cluster-wide
  `sdel` frame; every replica's `ResourceHandle.deleted` (React: `useResource().deleted`)
  flips so consumers re-read.

## Options

Both halves take `resolveOptions(id)`, returning per-Resource [`DocOptions`](src/index.ts).
Supply the **same** resolver to server and client — ideally imported from one shared
module — so both build each Resource's `StoreValue` identically (mode/opaque can't drift).

| Option | Where | Meaning |
| --- | --- | --- |
| `resolveOptions(id)` | server + client | Returns `DocOptions` for a Resource, or `undefined` for the default. |
| `origin` | client | Stable origin id for echo-breaking (defaults to a random id per client). |
| `DocOptions.mode` | resolver | `'shallow'` (default — top-level keys and arrays merge, nested objects stay opaque) or `'document'` (recursive nested-field merge). |
| `DocOptions.opaque` | resolver | Named subtrees to keep atomic (required for discriminated-union blobs). |

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guide: [Store](https://mertdogar.github.io/super-line/guide/store) · [synced state](https://mertdogar.github.io/super-line/guide/synced-state)
- 🧩 Example: [`store-sync-json`](https://github.com/mertdogar/super-line/tree/main/examples/store-sync-json)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
