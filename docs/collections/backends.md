# Backends & clustering

A backend decides where collection state lives, how durable it is, and how it replicates across a cluster. Backends are **drop-in** — swapping one is a one-line change; nothing above it moves.

There are **two backend seams**, because the two consistency models are stored differently:

- `collections:` — the [row collection](/collections/row-collections) backend (one per server, a single transaction domain → atomic cross-collection batches).
- `crdtCollections:` — the [CRDT document collection](/collections/crdt-documents) backend (separate; CRDT never joins a cross-collection atomic batch).

## The clustering axis: `relay` vs. `self`

Every backend is one of two clustering models:

- **`relay`** — each node holds a full replica and replicates writes over the server↔server [adapter](/how-to/choose-an-adapter) (Redis/libp2p/RabbitMQ/ZeroMQ). Simple, adapter-driven.
- **`self`** — the backend owns a **central Postgres** and a per-node Electric-synced replica, and needs **no adapter** at all. Cross-node convergence rides Postgres + Electric instead of super-line's fan-out.

Don't confuse `self` clustering with the [transport](/concepts/transports-and-adapters) or the adapter — a `self` backend bypasses the adapter entirely.

## Row backends

| Package | Durability | Clustering |
| --- | --- | --- |
| **`@super-line/collections-memory`** | in-memory | `relay` |
| **`@super-line/collections-sqlite`** | SQLite (better-sqlite3, WAL) | `relay` |
| **`@super-line/collections-pglite`** | central Postgres + Electric→PGlite | **`self`** |

The SQL backends store each LWW collection in its **own typed table** (`col_<name>`): scalar schema fields become real columns, everything else a per-field JSON column, derived from the contract — so both factories take the contract's `collections` map. `collections-sqlite` compiles the [query IR](/collections/row-collections#the-query-ir) against those columns (an exactly-compilable query runs entirely in SQL); `collections-pglite` is the self-clustering tier (central Postgres + one Electric shape per table streaming into each node's replica).

```ts
// swap the backend — nothing else changes
import { sqliteCollections } from '@super-line/collections-sqlite'
createSuperLineServer(api, { /* … */, collections: sqliteCollections({ file: './data.db', collections: api.collections }) })
```

::: warning What disqualifies a query
Not every query compiles to SQL — a few operators can't be translated without diverging from the JS evaluator's semantics, so `collections-sqlite` falls back to a full table scan (JS-filtered, and JS-sorted if `orderBy` is affected too):

- **`like` / `ilike`** — SQLite's `LIKE` case rules don't match the evaluator's regex semantics.
- **`neq` on a JSON-backed column** — a non-scalar schema field (record/union/nested/optional+nullable), where SQL's `1`/`0` vs `true`/`false` collide under `IS NOT`.
- **Any text range comparison** (`lt`/`lte`/`gt`/`gte` against a string) **or text `orderBy`** — SQLite orders text by UTF-8 bytes, the JS evaluator by UTF-16 code units, and the two disagree on astral-plane characters.

None of this affects correctness — the JS evaluator stays authoritative either way — but it's a silent perf cliff: a filter or sort that touches one of these falls back to scanning and sorting the whole table in JS instead of letting SQLite do it.
:::

## CRDT backends

| Package | Durability | Clustering |
| --- | --- | --- |
| **`@super-line/collections-crdt-memory`** | in-memory | `relay` |
| **`@super-line/collections-crdt-libsql`** | libsql / Turso (snapshot-per-doc) | `relay` |
| **`@super-line/collections-crdt-pglite`** | central Postgres Yjs op-log + Electric→PGlite | **`self`** |

`collections-crdt-memory` also exports the universal [`crdtCollectionsClient()`](/collections/crdt-documents#client-open-a-document) — one client engine pairs with every backend tier (the client only merges opaque deltas). The `libsql` tier awaits an async factory (`await crdtLibsqlCollections(...)`) and snapshots per document; the `pglite` **self** tier (`await crdtPgliteCollections(...)`) validates each write before appending it as an opaque Yjs delta to an append-only op-log in Postgres, which Electric streams to each node's PGlite replica. See [validate-before-commit](/collections/crdt-documents#validate-before-commit) for why op-log compaction demands tolerant schemas.

## Advisory foreign keys

`references` on a contract collection is metadata; opt into an existence check with `checkReferences: true` on the server. It's **advisory**:

- best-effort under `relay` clustering (no global serialization point),
- no cascades,
- doesn't resolve intra-batch parent-then-child references.

For strict referential integrity, use a **`self` backend** (a central Postgres serialization point) or route the write through a request handler that checks explicitly. The metadata still feeds the Control Center schema graph and the [TanStack adapter's](/collections/tanstack-db) join hints regardless of whether the check is on.

## Next

- [Row-level security & policies](/collections/policies) — how routing respects `read` filters per backend.
- [Choose an adapter](/how-to/choose-an-adapter) — the server↔server fan-out that `relay` backends ride.
- [Transports vs. adapters](/concepts/transports-and-adapters) — where the `self` tier sits relative to both.
