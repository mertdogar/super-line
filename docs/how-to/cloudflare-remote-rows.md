# Serve another Durable Object's tables live

Serve the tables inside a Durable Object that is **not** your super-line node as a live, read-only row collection. The other object — the **source** — keeps its own SQLite, its own write path, and tables created at runtime with whatever SQL its users run. The node fronts any number of sources and serves their rows to subscribers like any other [row collection](/collections/row-collections): a snapshot on subscribe, then every insert, update, and delete as it commits.

This page assumes a node [hosted on Cloudflare Durable Objects](/how-to/cloudflare-durable-objects). Four pieces do the work:

| Piece | Runs in | What it does |
| --- | --- | --- |
| `syncedSql(ctx, options)` | the source | Captures every row change with SQLite triggers, and pushes each committed batch to the node |
| `remoteRows(options)` | the node | A read-only collection backend fed by those pushes, reading snapshots from the source |
| `remoteRowsCollection(name)` | the contract | Declares the collection: one row per source row, its columns opaque under `data` |
| `composeCollections(backends)` | the node | Serves that one collection from `remoteRows` and the rest from your usual backend |

The first three come from `@super-line/collections-cloudflare`, and `composeCollections` from `@super-line/server`.

```bash
pnpm add @super-line/collections-cloudflare
```

## How changes travel

The source keeps a **clock** that moves once per write batch. After a batch commits, the source pushes `{ epoch, clock, changes }` to the node. When the push carries the clock right after the last one the node applied, the node applies its changes and fans them out; otherwise — it missed a push, the batch was too large to send inline, or the source was reset — the node asks the source for everything since its last clock (`changesSince`) and applies that instead.

A subscribe always reads straight from the source, after catching up. When the history the node needs is gone — a table was dropped or altered, say — the source answers `wipeAll`, and you close the sockets reading that source so their clients reconnect into a fresh snapshot. [When the history breaks](#when-the-history-breaks) covers the causes.

## Configure wrangler

Both classes must be SQLite-backed, and the Worker binds both: the source calls the node to push, and the node calls the source to read.

```jsonc
// wrangler.jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "NODE", "class_name": "Node" },
      { "name": "STORE", "class_name": "Store" }
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Node", "Store"] }]
}
```

Adding a source class to a deployed app takes a new migration tag that lists only the new class.

## Declare the collection

Add `remoteRowsCollection(name)` to the contract's `plugins`. It declares one collection holding the rows of every source the node fronts:

```ts
// contract.ts
import * as z from 'zod'
import { defineContract } from '@super-line/core'
import { remoteRowsCollection } from '@super-line/collections-cloudflare/contract'

export const contract = defineContract({
  collections: { notes: { schema: z.object({ id: z.string(), text: z.string() }), key: 'id' } },
  roles: { user: { clientToServer: {} } },
  plugins: [remoteRowsCollection('storeRows')],
})
```

Import it from the `/contract` subpath: it pulls in only `zod` and `@super-line/core`, so a contract package shared with a browser never imports `cloudflare:workers`. The subpath also exports the types of a source's `query` — `Statement`, `Outcome`, `Result`, `Value`, and `QueryOptions` — for a page that calls it through your Worker.

Every row has the same shape:

| Field | Value |
| --- | --- |
| `key` | `` `${storeId}:${table}:${id}` `` — the collection's key |
| `storeId` | The source's id, as the node names it |
| `table` | The source table the row lives in |
| `id` | The table's single-column primary key, else its `rowid`, as a string |
| `data` | Every column of the row. A value is a string, a number, `null`, or `{ blob }` with the bytes in base64 |

`data` is opaque to the contract because the source's tables don't exist at build time. Parse it on the client, where you know which table you subscribed to. A `rowid` table's `data` has no `rowid` column; a table with a primary key carries the key in `data` too.

## Capture changes in the source

Build `syncedSql` over the source's own `ctx`, and expose four methods: `query` as the object's write path, and `snapshot`, `get`, and `changesSince` for the node to read.

```ts
// store.ts
import { DurableObject } from 'cloudflare:workers'
import { syncedSql, type QueryOptions, type Statement } from '@super-line/collections-cloudflare'

// Named `<node>:<store>` with getByName, so the object knows which node to push to.
export class Store extends DurableObject<Env> {
  private sync = syncedSql(this.ctx, {
    onChange: (push) => {
      const [node, storeId] = this.ctx.id.name!.split(':') as [string, string]
      return this.env.NODE.getByName(node).storeChanged(storeId, push)
    },
  })

  query(statements: Statement[], opts?: QueryOptions) {
    return this.sync.query(statements, opts)
  }
  snapshot(table: string, limit: number) {
    return this.sync.snapshot(table, limit)
  }
  get(table: string, id: string) {
    return this.sync.get(table, id)
  }
  changesSince(clock: number) {
    return this.sync.changesSince(clock)
  }
}
```

**Route every write through `query`.** It runs a batch of statements in order inside one transaction, and it's what moves the clock and pushes. The first failing statement rolls the whole batch back and comes back as `{ error, statement }` rather than a throw. `{ readOnly: true }` rolls back as soon as a statement writes a row or changes the schema, and `maxBytes` (default 16 MiB, half the RPC limit) rolls back once the batch's result rows pass the cap. A write made with `ctx.storage.sql.exec` directly isn't pushed when it commits.

Tables need no registration. Every user table gets `AFTER INSERT/UPDATE/DELETE` triggers, a batch that changes the schema re-syncs them, and a table created in a batch is captured whole — `CREATE TABLE` followed by `INSERT` in one batch works. A row's id is its single-column primary key, else its `rowid`. An `UPDATE` that changes the key reads as a delete of the old id and a put of the new one.

| Option | Default | What it does |
| --- | --- | --- |
| `onChange(push)` | — | Called after every batch that changed rows, once it committed. A throw or rejection is logged and dropped |
| `maxInlineChanges` | `500` | Changes a push carries inline. A larger batch pushes its clock alone, and the node pulls |
| `maxTombstones` | `1000` | Delete markers kept for `changesSince`. Older ones are pruned, oldest first, and the history starts after them |
| `maxPullChanges` | `5000` | Changes `changesSince` answers with. A longer backlog answers `wipeAll` instead of a partial list |

`syncedSql` owns everything prefixed `_sl_` in the source's SQLite: the `_sl_changes` log, the `_sl_meta` clock, and one trigger per table and operation. Don't create objects with that prefix yourself.

## Serve the rows from the node

On the node, build `remoteRows` and compose it beside your usual backend. Give `cloudflareCollections` only the collections it owns — given the whole map, it also lays out an empty table for the remote collection.

```ts
// worker.ts
import { composeCollections, createSuperLineServer } from '@super-line/server'
import { createDurableNode } from '@super-line/transport-cloudflare'
import { cloudflareCollections, remoteRows, type RemotePush } from '@super-line/collections-cloudflare'
import { isIn } from '@super-line/core'
import { contract } from './contract'

const { storeRows: _, ...owned } = contract.collections

export class Node extends createDurableNode((ctx, env: Env, base) => {
  const storeRows = remoteRows({
    collection: 'storeRows',
    storage: ctx.storage,
    stub: (storeId) => env.STORE.getByName(`${ctx.id.name}:${storeId}`),
    // the source's history broke: send its readers back for a fresh snapshot
    onWipe: (storeId) => {
      for (const conn of server.local.connections) if (conn.ctx.stores.includes(storeId)) conn.raw.close(4409, 'resync')
    },
  })

  const server = createSuperLineServer(contract, {
    ...base,
    authenticate,
    collections: composeCollections({ default: cloudflareCollections(ctx.storage, owned), storeRows }),
    policies: {
      notes: { read: () => undefined, write: () => true },
      storeRows: { read: (_principal, ctx) => isIn('storeId', ctx.stores) }, // write omitted: denied
    },
  })

  // a wake restores subscriptions without reading the source, so catch up every source the node has served
  void server.ready.then(() => storeRows.resume())

  return Object.assign(server, { storeRows })
}) {
  // the source's onChange lands here
  storeChanged(storeId: string, push: RemotePush) {
    return this.server.storeRows.ingest(storeId, push)
  }
}
```

The example's `authenticate` puts the stores each connection may read in `ctx.stores`. Your app holds that mapping somewhere — in `ctx`, or in its own rows — and three places use it:

- **The `read` policy** returns the filter a connection's subscriptions are held to. The policy is computed at subscribe, so a connection that gains a store sees it after it resubscribes — the [policy staleness](/collections/policies) rule every collection has.
- **`onWipe`** decides which sockets to close. Closing every connection is also correct; it just disconnects clients that weren't reading that source.
- **`resume`** pulls what sources changed while the node slept. A hibernation wake brings every subscription back without reading a snapshot, so `remoteRows` doesn't learn which sources they read; your code calls `resume` once `server.ready` resolves. With no arguments it catches up every source the node keeps a clock for. To catch up only the sources still in use, pass their ids: `resume([...new Set(server.local.connections.flatMap((conn) => conn.ctx.stores))])`. A source you leave out catches up at its next push or its next subscribe.

| Option | Default | What it does |
| --- | --- | --- |
| `collection` | — | **Required.** The name you gave `remoteRowsCollection` |
| `storage` | — | **Required.** Where the node keeps the last clock it applied per source: the node's `ctx.storage` |
| `stub(storeId)` | — | **Required.** The source for a store id — its Durable Object stub |
| `onWipe(storeId)` | does nothing | Called when a source's history broke and its subscribers may hold stale rows |
| `snapshotLimit` | `1000` | The most rows a snapshot reads from the source table |

`remoteRows` returns the backend with two methods of its own: `ingest(storeId, push)`, which your forwarding method calls with each push, and `resume(storeIds?)`.

### How the composite routes

`composeCollections({ default, ...byName })` makes one backend out of several. A collection named in it goes to its own backend, every other collection to `default`, and live changes arrive from all of them.

- **Atomicity is per backend.** A batch that spans two backends fails with `VALIDATION` before anything applies.
- **Mixing a `self` backend with a `relay` one makes the composite `relay`**, and the `self` collections in it become read-only: a write to them fails with `FORBIDDEN`. Snapshots, reads, and their live feed work as usual. `remoteRows` is `self`, and read-only anyway, so this costs nothing here.
- **A backend you name twice is one backend.** A batch across its names stays inside it.
- **Every name other than `default` must be a row collection on the contract.** The server refuses to start otherwise.

## Subscribe from a client

Nothing on the client is specific to this backend: `storeRows` is an ordinary row collection. Its filter must pin `storeId` and `table` with `eq()`, so the node knows which source table to read — a subscribe without both fails with `VALIDATION`.

```ts
import { and, eq } from '@super-line/core'

const dishes = client.collection('storeRows').subscribe({
  filter: and(eq('storeId', 'downtown'), eq('table', 'dishes')),
  limit: 100,
})
await dishes.ready
const menu = dishes.rows().map((row) => dishSchema.parse(row.data))
```

The rest of the filter — `eq('data.available', 1)`, say — and `orderBy` run on the node, over the rows it read. The node reads at most `snapshotLimit` rows of the table, so a query over a larger table sees only part of it. Live changes aren't capped, but every snapshot is, including the one a client reads when it resubscribes, so a subscription to a table over the limit can shrink on any reconnect. When the pins are the whole filter — a `read` policy's filter counts — and there is no `orderBy`, the read stops at the query's own `offset + limit`.

React's `useCollection` takes the same query.

## Write through the source

The collection is read-only: `insert`, `update`, `delete`, and `batch` on it fail with `FORBIDDEN`. Writes go through the source's own path, and their changes come back to every subscriber through the push. A request handler on the node is one way to offer them to clients:

```ts
// a request on the contract, implemented in the node's factory
renameDish: async ({ storeId, id, name }) => {
  const outcome = await env.STORE.getByName(`${ctx.id.name}:${storeId}`).query([
    { sql: 'UPDATE dishes SET name = ? WHERE id = ?', params: [name, id] },
  ])
  if ('error' in outcome) throw new SuperLineError('VALIDATION', outcome.error)
  return null
},
```

## When the history breaks

The node can only apply changes it can account for. When it can't, the source answers its pull with `wipeAll`, the node calls `onWipe` for that source and starts again from the source's current clock, and you close the sockets that read it. Their clients reconnect as after any drop and resubscribe into a fresh snapshot.

A source's history breaks when:

- **A table is dropped or renamed.** No row trigger fires for either.
- **A column is added, dropped, or renamed.** Every unchanged row the node already sent is in the old shape — even when no subscriber reads that column.
- **Deletes the node hasn't seen were pruned.** The source keeps the newest `maxTombstones` delete markers, so a node whose last clock predates a pruned one resyncs.
- **The backlog since the node's last clock exceeds `maxPullChanges`.** A large bulk write while the node missed its push does this.
- **The source was reset.** `ctx.storage.deleteAll()` followed by a new write restarts the clock under a new epoch.

A break resyncs every subscriber of that source, not only those reading the table that changed. Creating a table breaks nothing.

`4409` is the code the Cloudflare transport also uses for a socket it couldn't resume (`CLOSE_NOT_RESUMABLE`), so a client already treats it as a plain reconnect.

## Operational facts

These follow from the design and are worth knowing before you ship:

- **A lost push isn't retried.** The node heals at the source's next push (it sees the skipped clock and pulls), at the next subscribe to that source, or at `resume` after a wake. Until one of those happens, the node's subscribers miss that batch.
- **A source's feed starts at its first subscribe on the node.** A push from a source nobody has subscribed to is ignored; the subscribe reads a fresh snapshot anyway.
- **A delete reaches every subscriber of the collection on the node.** It carries only the row's key — `storeId:table:id`, never data — because the node can't tell who held the row. Treat the store ids, table names, and row ids of deleted rows as visible to every subscriber of the collection on that node. An insert or update reaches only the subscribers whose filter and policy admit its store and table — `remoteRows` declares `storeId` and `table` as fields that never change for a key, so the server can rule the others out. One of those whose filter on `data` doesn't match gets the same key-only delete, so it can drop a row an update moved out of its filter.
- **Each push is a call to the node, and each subscribe a call to the source.** A source pushes every batch whether or not anyone subscribes, so a source that writes often keeps the node awake, as any request does.
- **The source runs with `recursive_triggers` on**, so an `INSERT OR REPLACE` that evicts a conflicting row logs that row's delete. Triggers of your own run recursively too.
- **`meta.rowsWritten` counts the change log's writes**, as Cloudflare's billing does, so a batch reports more rows written than it changed.
- **Store ids and table names must not contain `:`.** A key splits at its first two colons; a row id may contain colons.
- **A `WITHOUT ROWID` table with a composite primary key isn't synced.** The source logs a warning and serves no rows from it.
- **Reading one row by key binds the id as text.** An `INTEGER` key matches; a key column with no declared type that holds numbers, or a `BLOB` key, doesn't. Subscriptions are unaffected.

## Next

- [Host a node on Cloudflare Durable Objects](/how-to/cloudflare-durable-objects) — the node this page builds on.
- [Backends & clustering](/collections/backends) — how `remoteRows` compares with the other backends.
- [Row-level security & policies](/collections/policies) — writing the `read` filter.
- [Reconnection & delivery](/concepts/reconnection-delivery) — what a client does after the 4409 close.
