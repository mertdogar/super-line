# @super-line/collections-cloudflare

[**super-line**](https://super-line.dogar.biz/) [row collections](https://super-line.dogar.biz/collections/row-collections) stored in a Cloudflare **Durable Object's** own SQLite — the object that is the node (see [`@super-line/transport-cloudflare`](https://github.com/mertdogar/super-line/tree/main/packages/transport-cloudflare)). Each collection gets its own typed table, laid out exactly as [`@super-line/collections-sqlite`](https://github.com/mertdogar/super-line/tree/main/packages/collections-sqlite) does, with the same IR→SQL snapshot pushdown, and one `transactionSync` spans every collection, so a cross-collection batch stays atomic.

```bash
pnpm add @super-line/core @super-line/collections-cloudflare
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { createDurableNode } from '@super-line/transport-cloudflare'
import { cloudflareCollections } from '@super-line/collections-cloudflare'
import { contract } from './contract'

export class Node extends createDurableNode((ctx, env, base) =>
  createSuperLineServer(contract, {
    ...base,
    authenticate,
    policies,
    collections: cloudflareCollections(ctx.storage, contract.collections),
  }),
) {}
```

`cloudflareCollections(storage, collections)` is synchronous and opens on the first operation, so building it in the object's constructor costs nothing and never throws. It needs the contract's post-merge `collections` map. `clustering: 'relay'`, `coordination: 'local'` — one node, so nothing is relayed.

## Limits

Durable Object SQLite is stricter than a SQLite file:

- **98 typed columns per collection** (the platform allows 100; two are row timestamps). A wider collection fails its own operations with an `INTERNAL` error naming it; the rest keep working.
- **2 MB per row.** A larger write fails, and the client receives `INTERNAL`.
- **100 bound values per query.** A snapshot filter needing more than 98 values scans the table and filters in JavaScript — same results, slower on a large table.

## Schema changes on a deployed object

A new optional field is altered in on the first operation. Any other change — a field that changed type, a removed field, a new required field — makes that collection fail its operations with an `INTERNAL` error naming it and the fix, while the rest of the object works. Either rename the collection (a new table; the old rows stay unread), or migrate `col_<name>` and its `col_meta` row with `ctx.storage.sql.exec` in your factory before you create the server.

The backend owns the `col_<name>` and `col_meta` tables in the object's storage.

- 📖 Guide: [Host a node on Cloudflare Durable Objects](https://super-line.dogar.biz/how-to/cloudflare-durable-objects)
- 📚 Reference: [Backends & clustering](https://super-line.dogar.biz/collections/backends)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
