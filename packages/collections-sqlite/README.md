# @super-line/collections-sqlite

Durable SQLite `CollectionStore` backend for [**super-line**](https://super-line.dogar.biz/) [collections](https://super-line.dogar.biz/collections/backends) (better-sqlite3, WAL mode) — typed row collections that survive a restart. `relay` tier: each node holds a full replica and replicates writes over the server↔server [adapter](https://super-line.dogar.biz/how-to/choose-an-adapter).

```bash
pnpm add @super-line/collections-sqlite
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { sqliteCollections } from '@super-line/collections-sqlite'
import { api } from './contract'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  collections: sqliteCollections({ file: './data.db', collections: api.collections }),
})
```

Every LWW collection gets its own typed table (`col_<name>`), derived from the contract's Zod schema — so the factory REQUIRES the contract's (post-plugin-merge) `collections` map, not just a file path. Queries compile to SQL where exact; a few operators (`like`/`ilike`, text ranges/order, `neq` on a JSON-backed field) fall back to a full scan, JS-filtered — see the guide for the list.

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [backends & clustering](https://super-line.dogar.biz/collections/backends)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
