# PLAN — Remote rows: a foreign Durable Object's SQLite as a live collection

Make the user tables inside a Durable Object that is **not** the super-line node a live, read-only
collection for the node's subscribers. The reference consumer is super-omma: `OrganizationDO` is the
node, every `StoreDO` (`${orgId}:${storeId}`) is a raw SQL database whose tables users create at
runtime with arbitrary SQL. The design is tldraw's `SQLiteSyncStorage` (clock + tombstones +
`getChangesSince`) moved to the one hop where super-line still needs it — source DO → node DO after
the node hibernates — with SQLite triggers standing in for tldraw's in-code `lastChangedClock`.

Decided in a grilling session on 2026-10-20. Studied: `@tldraw/sync-core`'s `SQLiteSyncStorage`,
`DurableObjectSqliteSyncWrapper`, `TLSyncStorage` and the `sync-cloudflare` template's
`TldrawDurableObject`.

## Status

- **Phase 1 built (2026-10-20, uncommitted).** `syncedSql` in
  `packages/collections-cloudflare/src/synced-sql.ts`, exported from the package index. 17 workers-lane
  tests in `test-workers/synced-sql.workers.test.ts` against the `SqlSourceNode` fixture (next to the
  package's other workerd test, typechecked by `test-workers/tsconfig.json`); the lane is 8 files /
  89 tests green. Amended 2026-10-21: `maxPullChanges` and column changes as history breaks
  (decision 11).
- Phase 1 refinements of the decisions below:
  - Schema changes are detected by a **signature** (`type`, `name`, `sql` of every object outside the
    `_sl_` bookkeeping tables, **our `_sl_` triggers included**), not a `sqlite_master` count: a count misses
    `RENAME` and `ADD COLUMN`, and `PRAGMA schema_version` is not authorized in a Durable Object. The
    read-only check uses the same signature. (Phase 3 found the triggers had been left out: a `DROP TABLE`
    plus an identical `CREATE TABLE` in one batch then left the signature unchanged, so the batch didn't
    break the history, didn't move the clock, and the recreated table was never given triggers — every later
    write to it went uncaptured. Fixed 2026-10-21, regression in the drop/rename test.)
  - A table **created in a batch is backfilled** as puts at that batch's clock — its rows were written
    before its triggers existed (`CREATE TABLE` + `INSERT` in one batch is the common agent shape).
    Skipped when the same batch broke the history (decision 11).
  - The connection runs with **`recursive_triggers` on**, so an `INSERT OR REPLACE` that evicts a row on
    a `UNIQUE` conflict fires its delete trigger. Triggers log **delete-then-insert**, not
    `INSERT OR REPLACE`: an outer `INSERT OR IGNORE` would impose its policy on the trigger's insert.
  - A push from a batch that broke the history (drop/rename/column change, or pruned its own clock) carries
    `changes: undefined`, so the node pulls and sees `wipeAll` instead of applying an inline diff.
  - `meta.rowsWritten` now includes the triggers' log writes (Durable Object billing counts them).
- **Phase 2 built (2026-10-21, uncommitted).** `composeCollections` in
  `packages/server/src/collections/compose.ts`, exported from `@super-line/server`; 8 fast-lane tests plus
  the row conformance suite (through a non-default backend) in
  `packages/server/test/compose-collections.test.ts`, two of them a loopback server round trip. Refinement
  of decision 19: the composite is `self` only when every backend is; any mix is `relay`, and its `self`
  collections are **read-only through it** (`FORBIDDEN`) — a relay `apply` must be synchronous and return
  its changes, and the server re-applies every relayed batch on every node, so a write into a backend that
  propagates itself would land once per node. Snapshots, reads and that backend's own feed route as usual,
  which is exactly the `cloudflareCollections` + `remoteRows` shape (read-only anyway, decision 5). A
  backend named twice is one backend: one `onChange` subscription, one `close`, and a batch across its
  names is not a cross-backend batch.
- **Phase 3 built (2026-10-21, uncommitted).** `remoteRows` in
  `packages/collections-cloudflare/src/remote-rows.ts` (exported from the package index) and
  `remoteRowsCollection` in `src/contract.ts`, published as the `./contract` subpath (tsup entry, `exports`,
  root `paths` + vitest alias; it imports only `zod` and core, and `zod` joins the package's `dependencies` as in
  plugin-auth). `syncedSql` gained `get(table, id)` for `read`. 10 fast-lane unit tests in
  `packages/collections-cloudflare/test/remote-rows.test.ts` (fake source + storage: clock bookkeeping, per-store
  serialization, persisted clock across instances, `resume`, pinned-query refusal, limit pushdown, key parsing,
  read-only) and 6 workers-lane tests in `test-workers/remote-rows.workers.test.ts` — `SqlSourceNode`s named
  `<node>:<store>` forward their pushes to a `RowsNode` (`createDurableNode` + `composeCollections({ default:
  cloudflareCollections, storeRows: remoteRows })`) and a real client over the Cloudflare transport: snapshot +
  live insert/update/delete, clock-only push and gap → pull, eviction after a lost push → `resume`, drop table and
  epoch reset → `onWipe` → 4409 → resubscribe into a fresh snapshot, unpinned subscribe → `VALIDATION`, write →
  `FORBIDDEN`. Workers lane 9 files / 96 tests green. Refinements of the decisions below:
  - **`ingest(storeId, push)`** takes the source's `RemotePush` whole, not `(storeId, epoch, clock, changes)`.
    It applies inline only the next clock of the same epoch; an older clock of the same epoch is dropped (a
    pull already covered it); anything else pulls `changesSince(lastSeen)`, and a pull that says `wipeAll` or
    comes back under another epoch calls `onWipe` and moves `lastSeen` to the pulled clock. Steps run **one at
    a time per source** (a pull overtaken by a later one would land older rows last). `lastSeen` is
    `{ epoch, clock }` under `remote-rows:<collection>:<storeId>` in the node's KV storage.
  - **A source's feed starts at its first subscribe**: a push for a source with no `lastSeen` is ignored (no
    subscriber on this node can hold its rows), and the first subscribe learns the current clock with
    `changesSince(Number.MAX_SAFE_INTEGER)` — a clock from the future answers `wipeAll` with the clock alone —
    then reads its snapshot. Every later subscribe pulls first (decision 15).
  - **Changes are prev-less**: a put is `k: 'update'` with `next` and no `prev`, a delete `k: 'delete'` with
    neither. The node can't know the prior row, and the server's router (`route()` in
    `packages/server/src/collections/rows.ts`) has a branch for exactly this: a matching subscriber gets the
    row, and a non-matching one gets a **data-less delete** it drops unless it holds the row. `k: 'insert'`
    was rejected: it never reaches a non-matching subscriber, so a row an update moves out of a `data.*`
    filter would stay on the client. A non-matching subscriber gets a key-only delete (`storeId:table:id` — ids,
    never data), unless its filter rules out the row's `storeId` or `table` (Phase 4, below).
  - **Snapshot limit**: `snapshotLimit` (default 1000) caps the rows read from the source table. The query's
    own window (`offset + limit`) is pushed down only when the pins are the whole filter and there is no
    `orderBy`; otherwise the node reads up to the cap and `applyQuery` filters, sorts and windows.
  - **Wake catch-up is the host's call**: `resume(storeIds)`. A hibernation replay re-registers subscriptions
    without a snapshot, so the store never sees them, and the server exposes no per-connection subscription
    accessor to derive "sources with a surviving subscriber" from. The host knows its own mapping
    (super-omma: a screen's linked stores) and calls `resume` once `server.ready` resolves.
  - **`onWipe` is the host's** (default nothing): the store can't tell which connections hold a source's rows.
    `Conn.close()` takes no code, so the close is `conn.raw.close(4409, 'resync')`.
  - `read(id)` splits the key at its **first two colons**, so a store id and a table name must be colon-free
    (a row id may hold colons). It reads through `syncedSql.get`, which binds the id as text: an `INTEGER`
    key or rowid matches by affinity, a typeless key holding numbers or a `BLOB` key does not.
- **Phase 4 server fixes built (2026-10-21, uncommitted).** Docs + skill + ADR: next bullet.
  - **Prev-less fan-out is scoped by fixed fields.** A backend may name, per collection, the fields that never
    change for a key (`CollectionStore.fixedFields?(n)`, optional, in core; `composeCollections` routes it).
    `remoteRows` names `storeId` and `table`. For an update without `prev` whose new row doesn't match,
    `route()` skips the subscriber outright when core's `excludesOn(eff, next, fixed)` holds — the effective
    filter is false on those fields alone (a leaf on any other field is unknown; `and` excludes if any conjunct
    does, `or` if every branch does, `not` never). A field that can change can't scope it: a sub on
    `status = 'open'` holding the row must still get the key-only delete when an update closes it (the pglite
    leave-filter case). A prev-less delete carries no row, so it still reaches every subscriber.
  - **`composeCollections` names are checked at server construction**: a key other than `default` that isn't a
    row collection on the contract throws (the composite remembers its names; the server checks them against
    its `defs`).
  - **Give the default backend only its own collections**: `const { storeRows: _, ...owned } =
    contract.collections`, then `cloudflareCollections(storage, owned)` — no helper. Stated on
    `composeCollections`, used by the `RowsNode` fixture.
- **Phase 4 docs built (2026-10-21, uncommitted).** ADR-0029
  (`docs/adr/0029-a-foreign-durable-objects-sqlite-is-a-read-only-live-collection.md`, + its ledger row); how-to
  `docs/how-to/cloudflare-remote-rows.md` (sidebar How-to › Collections, how-to index, the Cloudflare guide's Next);
  a `remoteRows` section in `docs/collections/backends.md`; the package README; all four `skills/super-line/` files
  (RECIPES gains a "Remote rows" recipe). They state the fixed-field fan-out (deletes still reach every subscriber)
  and the composite name check above.

## Why not tldraw's shape verbatim

tldraw keeps data and sockets in one object, so its clock serves the **client**: each session
catches up with `getChangesSince(clock)` and is told `wipeAll` in-protocol. super-line already owns
client catch-up — a reconnecting client re-`csub`s and receives a full snapshot
(`packages/server/src/collections/rows.ts`), and a hibernation replay re-registers subs without a
re-read. Here the data lives in a *different* object, so the clock serves the **node** only. Nothing
of tldraw's per-session machinery is needed; its storage-portability wrapper
(`TLSyncSqliteWrapper`) isn't either, since the source is Durable-Object-specific by definition.

## Decisions

### Topology

1. **Source DO stays separate** from the node — it has pre-existing tables and write paths, and its
   schemas are unknown at build time. Merging it into the node (`cloudflareCollections`) is not an
   option.
2. **Node = one object fronting N sources** (super-omma: OrgDO ↔ its stores). The node keeps
   `lastSeenClock` **per source id** in its own `ctx.storage`.
3. The source derives the node's name from its own (`ctx.id.name` = `org:store`) and pushes to
   `env.ORGANIZATION.getByName(orgId)`.

### Contract

4. **One generic contract collection**, shipped by super-line: `remoteRowsCollection(name)` →
   `{ key, storeId, table, id, data }` with `key = \`${storeId}:${table}:${id}\``, `data` opaque
   (`Record<string, Value>`, `Value = string | number | null | { blob: base64 }` — the source's
   existing wire type, no type sniffing). Runtime-declared collections in core were rejected: the
   contract stays the single build-time source of truth; typing lands client-side, where the table
   schema is known at runtime.
5. **Read-only.** `write` policy omitted ⇒ denied; the self-store's `apply` throws `FORBIDDEN`.
   Writes keep going through the source's own path (super-omma: `POST /stores/{id}/query`). No
   `apply` RPC, no `conditionalApply`, no super-line-side validation.
6. **Policy** is the host's: super-omma gives a screen `{ storeId: { in: <stores linked by its live
   playlist version> } }` and a panel member `{}`. Filter is computed at subscribe (the documented
   staleness caveat); the existing `screen:{id}` `reload` push covers a newly linked store.

### Source side (`syncedSql(ctx, { maxTombstones, onChange })`)

7. **Change capture = SQLite triggers.** Writes are opaque SQL, so the wrapper installs
   `AFTER INSERT/UPDATE/DELETE` triggers on every user table. After any batch that changed
   `sqlite_master` (the source's existing count check, now ignoring `_sl_%` objects and triggers),
   triggers are re-synced for new/dropped tables. Whole-table diffing and SQL parsing were rejected.
8. **One log table does both tldraw jobs**: `_sl_changes(tbl, id, clock, op) PRIMARY KEY (tbl, id)`,
   written with `INSERT OR REPLACE` — it is the `lastChangedClock` index for live rows *and* the
   tombstone table (`op = 'delete'`), since user tables can't grow a clock column. `_sl_meta(epoch,
   clock, historyStartsAt)`, one row. The clock bumps once per write batch.
9. **Row identity**: the table's single-column PRIMARY KEY, else `rowid`. `WITHOUT ROWID` tables
   with composite keys are skipped with a logged warning (composite support later by joining with
   `:`). An `UPDATE` that changes the key logs `delete OLD` + `insert NEW`.
10. **Pruning** like `computeTombstonePruning`: delete-rows beyond `maxTombstones` (default 1000) go
    oldest-first, never splitting a clock, inside the write transaction (no timer — a pending one keeps
    the object awake). `historyStartsAt` moves up to the **newest pruned clock** (tldraw takes the
    oldest surviving one, a step more conservative) and never down. Put-rows are never pruned (one per
    live row, bounded by the data).
11. **`changesSince(clock)`** → `{ epoch, clock, changes: RemoteChange[], wipeAll }`; `wipeAll` when
    `clock < historyStartsAt`, when `clock > current` (tldraw's "something went wrong" rule), when
    the backlog since `clock` exceeds `maxPullChanges` (default 5000 — never a partial list, no
    paging, so a pull stays far under the 32 MiB RPC limit), or on epoch mismatch (the node's check).
    `wipeAll` carries empty `changes`. A `DROP TABLE`/`RENAME` fires no row triggers, and a column
    change (`ALTER TABLE … ADD/DROP/RENAME COLUMN`) leaves every unchanged row the node holds in the
    old shape, so a batch that does either sets `historyStartsAt = clock` and pushes the clock alone
    ⇒ the node's next pull is `wipeAll`. Rare, blunt, correct.
12. **`epoch`** is a random id written when `_sl_meta` is created. `destroy()` + first `query`
    restarts the clock at 0; the epoch is what lets the node notice. tldraw gets this for free (one
    object = one room).
13. **`snapshot(table, limit)`** = `SELECT *` from one table, limited. **`get(table, id)`** = one row by id
    (Phase 3, for the node's `read`).

### Propagation

14. **Push after commit, pull on wake.** Post-commit (`ctx.waitUntil`) the source pushes
    `{ epoch, clock, changes? }` to the node. `changes` is inline up to a threshold (~500 ops);
    above it the push carries the clock only and the node pulls `changesSince` — RPC serializes at
    most 32 MiB, so a bulk `INSERT … SELECT` must not ride the push. (tldraw's `onChange` is
    clock-only + pull always; ours inlines the common case to save a round trip.)
15. **Wake catch-up is lazy**: on node construction, `changesSince(lastSeenClock)` only for sources
    with a surviving subscriber. A source nobody subscribes to resets `lastSeenClock` on the next
    subscribe (whose snapshot is fresh anyway). Every new subscribe also re-pulls first.
16. **Push failure is accepted**: no retry, no alarm. The node heals on wake and on the next
    subscribe; a lost push with an awake node and no new subscriber is the one stale window.
17. **`wipeAll` handling**: no resync frame. The node `disconnect()`s every `server.connections`
    entry holding a sub on that source (4409 "resync"), resets `lastSeenClock` to the pulled clock,
    and clients reconnect + re-`csub` into a full snapshot.

### Node side (`remoteRows({ collection, storage, stub, onWipe, snapshotLimit })`)

18. A **`SelfCollectionStore`** (`clustering: 'self'`): the owner is external and the feed fires
    `onChange`, exactly like `collections-pglite` with Electric. `ingest(storeId, push)` is what the host's
    forwarder calls; `snapshot(n, query)` **refuses** a query that
    doesn't pin `storeId` by equality (`VALIDATION`; `table` optional since 0.3.0 — super-omma reads whole stores), pushes `limit` (default 1000) into
    the source, and lets `applyQuery` in the node do the rest of the filter.
19. **Composition**: super-line takes one `CollectionStore` per server, and the node already has
    `cloudflareCollections`. Add `composeCollections({ default, <name>: store })` to
    `@super-line/server` — routes `snapshot`/`read`/`onChange`/`rowMeta` by collection name; a batch
    spanning two backends throws. This is the one core-adjacent change.

### Packaging

20. All three pieces live in `@super-line/collections-cloudflare`: `syncedSql` (source), `remoteRows`
    (node), `remoteRowsCollection` (contract, `/contract` subpath so a contract package needn't
    pull `cloudflare:workers`). `composeCollections` in `@super-line/server`.

## Shape (super-omma)

```ts
// contract
plugins: [authContract(), designerContract, remoteRowsCollection('storeRows')]

// StoreDO
private sync = syncedSql(this.ctx, {
  maxTombstones: 1000,
  onChange: (push) => {
    const [organizationId, storeId] = this.ctx.id.name!.split(':')
    return this.env.ORGANIZATION.getByName(organizationId).storeChanged(storeId, push)
  },
})
query(statements, opts) { return this.sync.query(statements, opts) }   // unchanged signature
snapshot(table, limit) { return this.sync.snapshot(table, limit) }
get(table, id) { return this.sync.get(table, id) }
changesSince(clock) { return this.sync.changesSince(clock) }

// OrganizationDO
const { storeRows: _, ...owned } = contract.collections
const storeRows = remoteRows({
  collection: 'storeRows',
  storage: state.storage,
  stub: (storeId) => storeObject(env, state.id.name!, storeId),
  onWipe: (storeId) => { for (const c of server.local.connections) if (subscribedTo(c, storeId)) c.raw.close(4409, 'resync') },
})
createSuperLineServer(contract, {
  ...base,
  collections: composeCollections({ default: cloudflareCollections(state.storage, owned), storeRows }),
  policies: { storeRows: { read: (p, ctx) => ctx.role === 'screen' ? { storeId: { in: linked(p) } } : {} } },
})
storeChanged(storeId, push) { return storeRows.ingest(storeId, push) }
// after construction: server.ready.then(() => storeRows.resume(storesWithLiveScreens()))

// player
client.collection('storeRows').subscribe({ filter: and(eq('storeId', storeId), eq('table', 'dishes')), limit: 1000 })
```

## Phases

1. **`syncedSql`** in the source: triggers, `_sl_changes`/`_sl_meta`, `query` funnel, `snapshot`,
   `changesSince`, pruning, epoch, DDL handling. Workers-lane tests (`*.workers.test.ts`) against a
   fixture DO: insert/update/delete/key-change/drop-table/destroy-recreate each produce the right
   `changesSince`.
2. **`composeCollections`** in `@super-line/server` + conformance against two memory backends.
3. **`remoteRows`** + `remoteRowsCollection`: ingest, lazy wake catch-up, pinned-query refusal,
   push-size threshold, `wipeAll` → disconnect. Workers-lane test with a source DO + a node DO and a
   real client: live `cchg` across the hop, catch-up after a simulated hibernation, wipe path.
4. Docs + `skills/super-line/` (all four files) + ADR.

## Open

- Composite primary keys (deferred, join with `:`).
- A table-scoped resync instead of per-store `wipeAll` on `DROP TABLE` — only if it turns out to be
  common.
- ~~**Prev-less fan-out** (Phase 3)~~ — built in Phase 4: fixed fields scope it (Status). Prev-less deletes
  still reach every subscriber.
- ~~**`cloudflareCollections(storage, contract.collections)`** lays out an unused `col_storeRows`~~ — Phase 4:
  pass the default backend only its own collections (Status).
