# @super-line/collections-crdt-libsql

Durable CRDT `CrdtCollectionStore` backend for [**super-line**](https://super-line.dogar.biz/) [CRDT document collections](https://super-line.dogar.biz/collections/crdt-documents) (Yjs, via super-store) — snapshots each document to libsql/Turso so state survives a restart. `relay` tier: each node holds a full replica and replicates over the server↔server [adapter](https://super-line.dogar.biz/how-to/choose-an-adapter).

```bash
pnpm add @super-line/collections-crdt-libsql
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { crdtLibsqlCollections } from '@super-line/collections-crdt-libsql'
import { api } from './contract'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  crdtCollections: await crdtLibsqlCollections({
    url: 'file:./scenes.db', // or a libsql://…/Turso URL, plus authToken
    docOptions: (n) => api.collections[n]?.crdt,
  }),
})
```

`crdtLibsqlCollections` is an **async** factory: it rehydrates every document's Yjs state from libsql (history-preserving) before returning a ready backend. Persistence is a debounced snapshot-per-doc write off the hot path (`debounceMs`, default 250ms) — `apply`'s validate-before-commit stays synchronous.

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [CRDT document collections](https://super-line.dogar.biz/collections/crdt-documents)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
