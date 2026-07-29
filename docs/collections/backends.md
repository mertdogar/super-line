# Backends & clustering

A backend decides where collection state lives, how durable it is, and how it replicates across a cluster. Backends are **drop-in** — swapping one is a one-line change; nothing above it moves.

There are **two backend seams**, because the two consistency models are stored differently:

- `collections:` — the [row collection](/collections/row-collections) backend (one per server, a single transaction domain → atomic cross-collection batches).
- `crdtCollections:` — the [CRDT document collection](/collections/crdt-documents) backend (separate; CRDT never joins a cross-collection atomic batch).

::: tip Just want to pick one?
This page is the reference — every capability, every option, every limit. For the decision itself, read **[choose a collection backend](/how-to/choose-a-collection-backend)** first; it gets you to a name in two questions.
:::

## The axes

A row backend is described by three properties. The first is obvious; the other two are declared on the backend itself and decide what it can promise you across nodes.

### Durability

Whether state outlives the process: in-memory, a local file, or a central database.

### Clustering: `relay` vs. `self`

- **`relay`** — each node holds a full replica and replicates writes over the server↔server [adapter](/how-to/choose-an-adapter) (Redis/libp2p/RabbitMQ/ZeroMQ). Simple, adapter-driven.
- **`self`** — the backend owns a **central Postgres** and a per-node Electric-synced replica, and needs **no adapter** at all. Cross-node convergence rides Postgres + Electric instead of super-line's fan-out.

Don't confuse `self` clustering with the [transport](/concepts/transports-and-adapters) or the adapter — a `self` backend bypasses the adapter entirely.

### Coordination: `local` vs. `cluster`

Clustering says how a write *reaches* other nodes. Coordination says whether the cluster can *agree at the moment of the write* — which is a stronger and separate guarantee:

- **`coordination: 'local'`** (memory · sqlite) — a conditional write is checked against **this node's** rows. Two nodes can each find the same condition satisfied and both proceed.
- **`coordination: 'cluster'`** (pglite) — conditional writes are serialized through the central Postgres, so exactly one node wins a contested claim.

Adding an adapter does not upgrade `local` to `cluster`: the adapter carries fan-out, not serialization. This distinction is what makes [`plugin-queue`](/how-to/plugin-queue) single-node on memory and sqlite, and cluster-wide on pglite.

## Row backends

| | `collections-memory` | `collections-sqlite` | `collections-pglite` |
| --- | --- | --- | --- |
| **Durability** | process memory | SQLite file (WAL) | central Postgres |
| **`clustering`** | `relay` | `relay` | **`self`** |
| **`coordination`** | `local` | `local` | **`cluster`** |
| **Survives a restart** | no | yes | yes |
| **Converges across nodes** | via adapter | via adapter | via Electric |
| **Cluster-wide conditional writes** | no | no | **yes** |
| **A new node sees pre-existing state** | no | its own file only | **yes** |
| **External infrastructure** | none | a writable path | Postgres + Electric |
| **Factory** | sync | sync | **async** |
| **Needs the contract `collections` map** | no | yes | yes |
| **Query execution** | JS evaluator | SQL when compilable, else JS | SQL narrowing, JS authoritative |
| **Row timestamps in Control Center** | yes | yes | yes |

```ts
// swap the backend — nothing else changes
import { sqliteCollections } from '@super-line/collections-sqlite'
createSuperLineServer(api, { /* … */, collections: sqliteCollections({ file: './data.db', collections: api.collections }) })
```

### `memoryCollections()`

Takes no arguments. Holds every collection's rows in nested maps and applies batches atomically through an undo log, so a failed batch leaves nothing behind. Zero dependencies.

### `sqliteCollections(options)`

Synchronous. Sets `journal_mode = WAL` and `synchronous = NORMAL`.

| Option | Type | Notes |
| --- | --- | --- |
| `file` | `string` | Path to the database file. `:memory:` for an ephemeral store. |
| `collections` | `Record<string, CollectionDef>` | **Required.** The contract's post-plugin-merge `collections` map — each LWW collection gets its own typed table. |

### `pgliteCollections(options)`

**Async** — `await` it. Writes and strong reads go to the central Postgres; change delivery arrives through this node's Electric-fed local replica.

| Option | Type | Notes |
| --- | --- | --- |
| `pgUrl` | `string` | **Required.** Central Postgres — source of truth for writes and strong reads. |
| `electricUrl` | `string?` | The Electric shape endpoint streaming each table into this node's replica. Required in practice: without a fed replica `onChange` never fires. Omit only if you pass `db` and feed the replica yourself. |
| `collections` | `Record<string, CollectionDef>` | **Required.** As above. |
| `tablePrefix` | `string?` | Prefix for the per-collection tables and the `<prefix>meta` fingerprint table. Defaults to `col_`. |
| `db` | `PGliteWithLive?` | Advanced/testing: supply the local replica yourself (needs the `live` extension). |

Postgres must run with `wal_level=logical` for Electric to replicate.

### Typed tables

The SQL backends store each LWW collection in its **own typed table** (`col_<name>`): scalar schema fields become real columns, everything else a per-field JSON column, derived from the contract — so both factories take the contract's `collections` map. `collections-sqlite` compiles the [query IR](/collections/row-collections#the-query-ir) against those columns (an exactly-compilable query runs entirely in SQL); `collections-pglite` is the self-clustering tier (central Postgres + one Electric shape per table streaming into each node's replica).

::: tip Which validators get typed columns
super-line reads a schema's shape through [Standard JSON Schema](https://standardschema.dev/json-schema), the companion spec to Standard Schema — so it never assumes a particular library and every implementer plans identically. That covers **Zod 4.2+**, **Zod Mini 4.2+**, **ArkType 2.1.28+**, **VineJS 4.3+**, **Sury 11+**, **stnl 2.1+**, and **Valibot 1.2+** (wrap the schema in `toStandardJsonSchema()` from `@valibot/to-json-schema`).

A validator whose library hasn't implemented the companion spec still works — it just can't be introspected, so its collection falls back to the key column plus one `_sl_data` JSON column. Everything is still validated, stored and queried correctly; you only lose SQL-level column typing and pushdown. The same fallback applies per-field to anything JSON Schema can't express, such as a `.transform()`.
:::

::: warning What disqualifies a query
Not every query compiles to SQL — a few operators can't be translated without diverging from the JS evaluator's semantics, so `collections-sqlite` falls back to a full table scan (JS-filtered, and JS-sorted if `orderBy` is affected too):

- **`like` / `ilike`** — SQLite's `LIKE` case rules don't match the evaluator's regex semantics.
- **`neq` on a JSON-backed column** — a non-scalar schema field (record/union/nested/optional+nullable), where SQL's `1`/`0` vs `true`/`false` collide under `IS NOT`.
- **Any text range comparison** (`lt`/`lte`/`gt`/`gte` against a string) **or text `orderBy`** — SQLite orders text by UTF-8 bytes, the JS evaluator by UTF-16 code units, and the two disagree on astral-plane characters.

None of this affects correctness — the JS evaluator stays authoritative either way — but it's a silent perf cliff: a filter or sort that touches one of these falls back to scanning and sorting the whole table in JS instead of letting SQLite do it.
:::

`collections-pglite` works differently: it compiles a **superset-safe `WHERE`** to narrow what it reads from Postgres, then always re-applies the full query in JS. The SQL is an optimization that never has to be exact, so there is no equivalent cliff — but also no full pushdown of sorting or limits.

## CRDT backends

| | `collections-crdt-memory` | `collections-crdt-libsql` | `collections-crdt-pglite` |
| --- | --- | --- | --- |
| **Durability** | process memory | libsql / Turso, snapshot per doc | central Postgres Yjs op-log |
| **`clustering`** | `relay` | `relay` | **`self`** |
| **Survives a restart** | no | yes | yes |
| **Converges across nodes** | via adapter | via adapter | via Electric |
| **External infrastructure** | none | a file, or Turso/sqld | Postgres + Electric |
| **Factory** | sync | **async** | **async** |
| **Boot cost** | none | rehydrates every document | replica sync |
| **Write persistence** | — | debounced snapshot | op-log append |

CRDT backends expose `clustering` but **no `coordination` flag**. There are no conditional writes to serialize — merge *is* the conflict-resolution model — so the axis doesn't apply.

[Validate-before-commit](/collections/crdt-documents#validate-before-commit) isn't a backend axis either: all three behave identically, validating at the **ingress node** while relay nodes trust an already-checked delta. Whether a document is validated at all is declared on the contract per collection — `crdt: { validate: false }` makes the server pass no validator, so the backend skips the merge-and-check entirely. See [turning ingress validation off](/collections/crdt-documents#turning-ingress-validation-off).

`collections-crdt-memory` also exports the universal [`crdtCollectionsClient()`](/collections/crdt-documents#client-open-a-document) — one client engine pairs with every backend tier (the client only merges opaque deltas).

### `crdtMemoryCollections()`

Takes no arguments. The Yjs merge engine every other tier wraps or mirrors.

### `crdtLibsqlCollections(options)`

**Async** — it rehydrates every document (history-preserving) before returning a ready backend, so boot time and memory both scale with total document count. Persistence is a debounced `onChange` subscriber, keeping the `apply` hot path synchronous.

| Option | Type | Notes |
| --- | --- | --- |
| `url` | `string` | **Required.** `file:x.db`, `:memory:`, `libsql://` (Turso), or `http(s)://` (sqld). |
| `authToken` | `string?` | Auth token for Turso Cloud. |
| `table` | `string?` | Table this backend owns. Defaults to `crdt_docs`. |
| `debounceMs` | `number?` | Coalesce rapid edits into one snapshot write. Defaults to `250`. |
| `docOptions` | `(collection: string) => DocOptions \| undefined` | Needed to rehydrate each document's Yjs state on boot. Derive it from the contract: `(n) => contract.collections[n]?.crdt`. |

A clean `close()` flushes pending edits; a hard kill loses at most `debounceMs` of writes.

### `crdtPgliteCollections(options)`

**Async.** Client writes are validated at the ingress node, then appended as opaque Yjs deltas to an append-only op-log in Postgres, which Electric streams to each node's replica.

| Option | Type | Notes |
| --- | --- | --- |
| `pgUrl` | `string` | **Required.** Central Postgres — the op-log and existence source of truth. |
| `electricUrl` | `string?` | Shape endpoint. Required in practice: without a fed replica no document change reaches a subscriber. |
| `table` | `string?` | Creates `<table>` (existence + materialized snapshot) and `<table>_updates` (the op-log). Defaults to `crdt_docs`. |
| `docOptions` | `(collection: string) => DocOptions \| undefined` | **Must agree** with the collection's `crdt` options on the contract. |
| `compact` | `false \| { everyNUpdates?, debounceMs? }` | Op-log compaction: fold the log, materialize a baseline, trim superseded rows. Bounds op-log growth. `false` disables it. |
| `db` | `PGliteWithLive?` | Advanced/testing: supply the local replica yourself. |
| `onError` | `(err, ctx) => void` | Called when a background op-log append fails. Server co-writes are synchronous and can't reject to the caller, so this is the only place that failure is observable. Defaults to `console.error`. |

See [validate-before-commit](/collections/crdt-documents#validate-before-commit) for why op-log compaction demands tolerant schemas.

## Cold start & convergence

`relay` clustering fans out **live batches** over the adapter. It performs **no state transfer to a node that joins** — a node starts from whatever its own local store holds and converges only forward from that point:

- **memory · crdt-memory** — a restarted node comes back **empty** and never receives anything written before it booted.
- **sqlite · crdt-libsql** — a restarted node comes back with its own file, missing everything written while it was down.

That is fine on a single node, and fine for state that is naturally re-created (presence, ephemeral sessions, caches). It is a real hazard for long-lived rows across a multi-node relay deployment.

::: warning One file per relay node
Don't point two nodes at the same SQLite file on a shared volume. A relay backend expects a **node-local** store: each node applies every relayed batch to its own copy, so a shared file receives the same batch once per node. If you want a genuinely shared database, that is the `self` tier.
:::

The `self` tier has no cold-start gap. Each node's replica is fed from the central Postgres, so a fresh node syncs current state on connect and reads stay strongly consistent against the centre.

## Advisory foreign keys

`references` on a contract collection is metadata; opt into an existence check with `checkReferences: true` on the server. It's **advisory**:

- best-effort under `relay` clustering (no global serialization point),
- no cascades,
- doesn't resolve intra-batch parent-then-child references.

For strict referential integrity, use a **`self` backend** (a central Postgres serialization point) or route the write through a request handler that checks explicitly. The metadata still feeds the Control Center schema graph and the [TanStack adapter's](/collections/tanstack-db) join hints regardless of whether the check is on.

## Next

- [Choose a collection backend](/how-to/choose-a-collection-backend) — the decision guide, if you landed here still undecided.
- [Row-level security & policies](/collections/policies) — how routing respects `read` filters per backend.
- [Run queues across a cluster](/how-to/queue-clusters) — [`plugin-queue`](/how-to/plugin-queue) stores jobs, schedules and concurrency slots in collections, so the backend you pick here is what decides whether a queue coordinates one node (memory · sqlite) or the whole cluster (pglite).
- [Choose an adapter](/how-to/choose-an-adapter) — the server↔server fan-out that `relay` backends ride.
- [Transports vs. adapters](/concepts/transports-and-adapters) — where the `self` tier sits relative to both.
