# @super-line/tanstack-db

[TanStack DB](https://tanstack.com/db) collection adapter for [**super-line**](https://super-line.dogar.biz/) [collections](https://super-line.dogar.biz/collections/tanstack-db) — super-line stays the server-authoritative sync source, TanStack DB becomes the client-side query engine (live queries, joins, optimistic mutations).

```bash
pnpm add @super-line/core @super-line/client @super-line/tanstack-db @tanstack/db
```

```ts
import { createCollection } from '@tanstack/db'
import { superLineCollectionOptions } from '@super-line/tanstack-db'
import { api } from './contract'

const users = createCollection(superLineCollectionOptions(client, api, 'users'))
const messages = createCollection(
  superLineCollectionOptions(client, api, 'messages', { query: { filter: eq('channelId', 'general') } }),
)
```

`superLineCollectionOptions` derives `getKey` from the contract, subscribes over super-line for the given query, and maps each optimistic TanStack transaction to **one atomic super-line batch** — the ack resolves the optimism, an error rolls it back. LWW row collections only; CRDT document collections are opened, not queried.

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [TanStack DB](https://super-line.dogar.biz/collections/tanstack-db)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
