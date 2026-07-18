# @super-line/collections-crdt-pglite

Self-clustering CRDT `CrdtCollectionStore` backend for [**super-line**](https://super-line.dogar.biz/) [CRDT document collections](https://super-line.dogar.biz/collections/crdt-documents) (Yjs, via super-store) — an append-only op-log in central Postgres that [Electric](https://electric-sql.com/) streams to a per-node PGlite replica, with validate-before-commit at the ingress node. `self` tier: no [adapter](https://super-line.dogar.biz/how-to/choose-an-adapter) needed.

```bash
pnpm add @super-line/collections-crdt-pglite
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { crdtPgliteCollections } from '@super-line/collections-crdt-pglite'
import { api } from './contract'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  crdtCollections: await crdtPgliteCollections({
    pgUrl: process.env.DATABASE_URL!,
    electricUrl: 'http://localhost:3000/v1/shape',
    docOptions: (n) => api.collections[n]?.crdt,
  }),
})
```

`crdtPgliteCollections` is an **async** factory: it creates the op-log + snapshot tables and boots the local replica before resolving. Pair it with `crdtCollectionsClient()` from `@super-line/collections-crdt-memory` on the client. Op-log compaction (periodic fold-to-baseline) is on by default — see the guide for why CRDT schemas need to stay presence-tolerant (`.catch`/`.optional`) under compaction.

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [CRDT document collections](https://super-line.dogar.biz/collections/crdt-documents)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
