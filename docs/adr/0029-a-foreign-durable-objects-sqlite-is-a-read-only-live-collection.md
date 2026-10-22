# ADR-0029: A foreign Durable Object's SQLite is a read-only live collection

- Status: Accepted
- Date: 2026-10-21 — decided in a grilling session on 2026-10-20, built 2026-10-21
- Plan: `docs/plans/PLAN-remote-rows.md`
- Builds on: [ADR-0009](0009-collection-store-is-discriminated-on-clustering.md) (the relay `apply` must be
  synchronous), [ADR-0027](0027-a-connection-is-reconstructible-from-its-snapshot.md) (a wake replays
  subscriptions without a snapshot)

## Context

The reference consumer, super-omma, runs one `OrganizationDO` as the super-line node and one `StoreDO` per
store. A store is a raw SQL database: users create its tables at runtime with arbitrary SQL, and it has write
paths of its own that predate super-line. Screens connected to the organization need those rows live.

Three facts shape the problem. The store's schemas are unknown at build time, so it can't be folded into the
node as `cloudflareCollections` — and it has pre-existing tables and writers, so it shouldn't be. Writes are
opaque SQL, so super-line can't see them on the way in. And a server takes exactly one `CollectionStore`,
while the node already has its own row collections.

tldraw's `SQLiteSyncStorage` solves the neighbouring problem — a clock, tombstones, `getChangesSince(clock)`,
`wipeAll` when history is gone — but in one object that holds both the data and the sockets, so its clock
serves the **client**: each session catches up in-protocol. super-line already owns client catch-up: a
reconnecting client re-`csub`s into a full snapshot, and a hibernation wake replays subscriptions without a
re-read. Here the data lives in a *different* object, so the one hop that still needs a clock is source →
node, after the node has slept or missed a push.

## Decision

**A foreign Durable Object's user tables become one read-only row collection on the node, fed by change
capture in the source and served by a `self` backend composed beside the node's own.** Three pieces in
`@super-line/collections-cloudflare` plus one in `@super-line/server`:

- **`syncedSql(ctx, opts)`** in the source. SQLite triggers replace tldraw's in-code `lastChangedClock`:
  every user table gets `AFTER INSERT/UPDATE/DELETE` triggers that log into one table, `_sl_changes(tbl, id,
  clock, op)` keyed `(tbl, id)`. That one table does both of tldraw's jobs — it is the last-changed index for
  live rows and the tombstone table for deletes — because user tables can't grow a clock column. The clock
  bumps once per write batch through `query`, the object's single write funnel. `changesSince(clock)` answers
  the changes since a clock, or `wipeAll` when that history is gone. A row's id is its single-column primary
  key, else its rowid. After commit, the source pushes `{ epoch, clock, changes? }` to the node, inline up to a
  threshold and clock-only above it.
- **`remoteRows(opts)`** on the node: a `SelfCollectionStore` whose feed is the source's pushes. `ingest`
  applies the next clock of the same epoch inline and pulls `changesSince(lastSeen)` for anything else; steps
  run one at a time per source, and `lastSeen` lives in the node's own storage. Snapshots read the source
  directly and must pin `storeId` by equality (`table` optionally: a store-wide read spans every table). Wake catch-up is the host's call (`resume`),
  because a replayed subscription never reaches the backend. A wipe is the host's call too (`onWipe`),
  answered by closing the affected sockets 4409 so clients reconnect into a fresh snapshot.
- **`remoteRowsCollection(name)`** on the contract: one generic collection, rows
  `{ key: storeId:table:id, storeId, table, id, data }` with `data` opaque. A `./contract` subpath, so a
  contract package doesn't import `cloudflare:workers`.
- **`composeCollections({ default, ...byName })`** in `@super-line/server`: one `CollectionStore` over several,
  routed by collection name.

### The history breaks bluntly

`wipeAll` is the answer whenever the node's clock can't be served exactly: it predates pruned tombstones, it is
from the future, the backlog since it exceeds `maxPullChanges`, or the epoch changed (`deleteAll` restarts the
clock at 0 under a new random epoch). A `DROP TABLE` or `RENAME` fires no row triggers, and a column change
leaves every unchanged row the node holds in the old shape, so a batch that does either moves
`historyStartsAt` to its own clock and pushes the clock alone; the node's next pull is `wipeAll`. The schema
is compared by a signature over `sqlite_master` that **includes our own triggers** — a count misses `RENAME`
and `ADD COLUMN`, `PRAGMA schema_version` isn't authorized in a Durable Object, and without the triggers a
drop plus an identical re-create in one batch leaves the signature unchanged and the new table untracked.

### Changes are prev-less

The node can't know a row's prior value, so a put is an `update` with `next` and no `prev`, and a delete has
neither. The server's router already has a branch for exactly this, from the pglite feed: a subscriber whose
filter matches gets the row, and every other subscriber gets a data-less delete it drops unless it holds the
row. That is what removes a row an update moves out of a `data.*` filter.

Sent to every subscriber, that delete would carry every source's keys to every screen on the node, so a backend
may now name, per collection, the fields that never change for a key: `CollectionStore.fixedFields?(n)`, optional,
routed by `composeCollections`. `remoteRows` names `storeId` and `table`. For a prev-less update whose new row
doesn't match, the router skips a subscriber whose effective filter (policy included) is already false on those
fields alone — no version of that row ever matched it. Core decides that with `excludesOn(filter, row, fields)`
(exported beside `matchesFilter`): a leaf on any other field is unknown, never false; `and` excludes if any conjunct
does, `or` only if every branch does, `not` never. A field that can change can't scope it: a subscriber on
`status = 'open'` holding the row must still get the delete when an update closes it.

### Mixed composites are relay, and their `self` collections are read-only

A composite is `self` only when every backend is. Any mix is `relay`, and writes into its `self` backends throw
`FORBIDDEN`: a relay `apply` must be synchronous and return its changes (ADR-0009), and the server re-applies
every relayed batch on every node, so a write into a backend that propagates itself would land once per node.
Snapshots, reads and the `self` backend's own feed need neither, so they route as usual — which is exactly the
`cloudflareCollections` + `remoteRows` shape, read-only anyway. A batch spanning two backends throws
`VALIDATION` before anything is applied (atomicity is per backend), and a backend named under two collection
names is one backend: one `onChange` subscription, one `close`, and a batch across its names stays inside it.
The server refuses to start when a composite routes a name, other than `default`, that isn't a row collection on
its contract.

## Considered and rejected

- **Runtime-declared collections in core** — one collection per source table, declared as tables appear. The
  contract stays the single build-time source of truth; typing lands client-side, where the table schema is
  known at runtime, by parsing the opaque `data`.
- **Whole-table diffing** after each batch. Cost proportional to the table, not the write, on every batch.
- **Parsing the SQL** to learn what a batch touched. Writes are arbitrary SQL, and the statement text doesn't
  say which rows an `UPDATE … WHERE`, an `INSERT … SELECT` or a `REPLACE` evicting a conflicting row touched.
  Triggers see every row change — with `recursive_triggers` on, which the source sets, an `INSERT OR REPLACE`
  that evicts a row on a `UNIQUE` conflict fires its delete trigger too.
- **A resync frame** in the wire protocol. Closing the socket 4409 reuses the client's existing reconnect and
  re-subscribe path, which already ends in a fresh snapshot; a frame would duplicate it on both ends.
- **Paging `changesSince`.** A backlog past `maxPullChanges` (default 5000) answers `wipeAll`, never a
  partial list: no cursor state on either side, and a pull stays far under the 32 MiB RPC limit.
- **Merging the source into the node.** Its tables, schemas and writers pre-exist and are unknown at build
  time.
- **tldraw's shape verbatim.** Its per-session catch-up and storage-portability wrapper solve problems
  super-line already solves, or doesn't have.
- **Puts as `insert`.** An `insert` never reaches a non-matching subscriber, so a row an update moves out of a
  `data.*` filter would stay on the client.
- **Retrying a lost push**, or an alarm to reconcile. A timer keeps the source awake and an alarm wakes it;
  the node heals instead at the source's next push (a gap pulls), the next subscribe, or `resume` on wake.
  Pruning likewise runs inside the write transaction, not on a timer.

## Consequences

- **A delete still reaches every subscriber of the collection on the node**, as a key-only delete: a prev-less
  delete carries no row, so fixed fields can't scope it. A deleted row's store id, table name and row id are
  therefore visible to every subscriber of that collection on that node; data never is. Fine for an
  organization's screens.
- **A source's feed starts at its first subscribe on the node.** A push from a source with no `lastSeen` is
  ignored; the first subscribe learns the current clock (`changesSince` from a future clock answers `wipeAll`
  with the clock alone) and reads its snapshot. Every later subscribe pulls first.
- **A lost push leaves one stale window**: an awake node, no later write from that source, and no new
  subscriber. Accepted.
- **Schema changes resync per source, not per table.** A table-scoped resync is deferred until a dropped table
  turns out to be common.
- **Keys split at their first two colons**, so store ids and table names must be colon-free; row ids may hold
  colons. A `WITHOUT ROWID` table with a composite key is skipped with a logged warning (composite keys are
  deferred). `read` by key binds the id as text, so an `INTEGER` key matches by affinity and a typeless key
  holding numbers or a `BLOB` key does not.
- **The source bills more writes than it made.** `meta.rowsWritten` includes the triggers' log writes, as
  Durable Object billing does.
- **`cloudflareCollections` given the whole contract map** also lays out an unused `col_<name>` table for the
  remote collection, since it is on the contract. Harmless; hosts pass it only the collections it owns.
