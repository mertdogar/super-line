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

## Serve another object's tables

`syncedSql` and `remoteRows` serve the tables of *other* Durable Objects — sources whose tables are created at runtime by arbitrary SQL — as one live, read-only collection on the node. Declare it on the contract with `remoteRowsCollection` from the `/contract` subpath, which imports only `zod` and `@super-line/core`:

```ts
import { remoteRowsCollection } from '@super-line/collections-cloudflare/contract'

export const contract = defineContract({ roles, plugins: [remoteRowsCollection('storeRows')] })
// rows: { key: `${storeId}:${table}:${id}`, storeId, table, id, data } — each row's columns opaque under `data`
```

In the source, `syncedSql(ctx, { onChange })` captures every row change with SQLite triggers, and pushes each committed batch to the node. Route every write through its `query`, and expose its reads for the node:

```ts
import { DurableObject } from 'cloudflare:workers'
import { syncedSql, type QueryOptions, type Statement } from '@super-line/collections-cloudflare'

export class Store extends DurableObject<Env> {
  private sync = syncedSql(this.ctx, {
    onChange: (push) => {
      const [node, storeId] = this.ctx.id.name!.split(':')
      return this.env.NODE.getByName(node).storeChanged(storeId, push)
    },
  })
  query(statements: Statement[], opts?: QueryOptions) { return this.sync.query(statements, opts) }
  snapshot(table: string, limit: number) { return this.sync.snapshot(table, limit) }
  get(table: string, id: string) { return this.sync.get(table, id) }
  changesSince(clock: number) { return this.sync.changesSince(clock) }
}
```

On the node, `remoteRows` is a `self` backend fed by those pushes, served beside this package's own backend through `composeCollections` from `@super-line/server`:

```ts
export class Node extends createDurableNode((ctx, env, base) => {
  const storeRows = remoteRows({
    collection: 'storeRows',
    storage: ctx.storage,
    stub: (storeId) => env.STORE.getByName(`${ctx.id.name}:${storeId}`),
    onWipe: (storeId) => closeReadersOf(storeId), // conn.raw.close(4409, 'resync') → they resubscribe into a fresh snapshot
  })
  const { storeRows: _, ...owned } = contract.collections
  const server = createSuperLineServer(contract, {
    ...base,
    authenticate,
    policies,
    collections: composeCollections({ default: cloudflareCollections(ctx.storage, owned), storeRows }),
  })
  void server.ready.then(() => storeRows.resume(storesInUse())) // a wake restores subscriptions without reading the source
  return Object.assign(server, { storeRows })
}) {
  storeChanged(storeId: string, push: RemotePush) {
    return this.server.storeRows.ingest(storeId, push)
  }
}
```

A subscription must pin both `storeId` and `table` with `eq()`, and writes fail with `FORBIDDEN` — they go through the source's `query`. Dropping, renaming or altering a table, pruned deletes, a backlog over `maxPullChanges` or a reset source breaks that source's history: `onWipe` runs, and its subscribers resync. Store ids and table names must be colon-free. The source owns every `_sl_`-prefixed object in its SQLite.

- 📖 Guide: [Host a node on Cloudflare Durable Objects](https://super-line.dogar.biz/how-to/cloudflare-durable-objects)
- 📖 Guide: [Serve another Durable Object's tables](https://super-line.dogar.biz/how-to/cloudflare-remote-rows)
- 📚 Reference: [Backends & clustering](https://super-line.dogar.biz/collections/backends)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
