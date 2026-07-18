# @super-line/collections-pglite

Self-clustering `CollectionStore` backend for [**super-line**](https://super-line.dogar.biz/) [collections](https://super-line.dogar.biz/collections/backends) — a central Postgres plus a per-node [Electric](https://electric-sql.com/)-synced PGlite replica (`live.changes`). `self` tier: Postgres + Electric is the only fan-out infra, no [adapter](https://super-line.dogar.biz/how-to/choose-an-adapter) needed.

```bash
pnpm add @super-line/collections-pglite
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { pgliteCollections } from '@super-line/collections-pglite'
import { api } from './contract'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  collections: await pgliteCollections({
    pgUrl: process.env.DATABASE_URL!,
    electricUrl: 'http://localhost:3000/v1/shape',
    collections: api.collections,
  }),
})
```

`pgliteCollections` is an **async** factory: it runs construction DDL (behind an advisory lock) and boots the local replica before resolving. Like `collections-sqlite`, it REQUIRES the contract's `collections` map — every LWW collection gets its own typed table on both the central Postgres and each node's replica.

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [backends & clustering](https://super-line.dogar.biz/collections/backends)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
