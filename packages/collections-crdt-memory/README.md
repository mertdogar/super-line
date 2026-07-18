# @super-line/collections-crdt-memory

In-memory CRDT `CrdtCollectionStore` backend for [**super-line**](https://super-line.dogar.biz/) [CRDT document collections](https://super-line.dogar.biz/collections/crdt-documents) (Yjs, via super-store) — merging collaborative docs (canvases, rich text, scene graphs) under the same `collection(n)` API as rows. `relay` tier: not durable, replicates over the server↔server [adapter](https://super-line.dogar.biz/how-to/choose-an-adapter).

```bash
pnpm add @super-line/collections-crdt-memory
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { crdtMemoryCollections, crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { api } from './contract'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  crdtCollections: crdtMemoryCollections(),
})
await srv.collection('scenes').create('board', {}) // creation is server-authoritative

const client = createSuperLineClient(api, {
  transport,
  role: 'user',
  crdtCollections: crdtCollectionsClient(), // the universal client engine — pairs with every CRDT backend tier
})
```

This package also exports `crdtCollectionsClient()` — the one client engine that pairs with every backend tier (memory, `-libsql`, `-pglite`); the client only ever merges opaque deltas.

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [CRDT document collections](https://super-line.dogar.biz/collections/crdt-documents)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
