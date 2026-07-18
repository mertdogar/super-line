# @super-line/collections-memory

In-memory `CollectionStore` backend for [**super-line**](https://super-line.dogar.biz/) [collections](https://super-line.dogar.biz/collections/backends) — the zero-dependency default for typed row collections. `relay` tier: not durable, replicates over the server↔server [adapter](https://super-line.dogar.biz/how-to/choose-an-adapter).

```bash
pnpm add @super-line/collections-memory
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { memoryCollections } from '@super-line/collections-memory'
import { api } from './contract'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  collections: memoryCollections(),
})
```

Rows live in memory and vanish on restart — reach for a durable backend (`@super-line/collections-sqlite` or `@super-line/collections-pglite`) once you need data to survive one. Swapping backends is a one-line change: nothing above `collections:` moves.

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [backends & clustering](https://super-line.dogar.biz/collections/backends)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
