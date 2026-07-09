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

`collections-sqlite` compiles the [query IR](/collections/row-collections#the-query-ir) to SQL to narrow snapshots at the source; `collections-pglite` is the self-clustering tier (central Postgres + per-node Electric replica, where `live.changes` carries only changed columns + the key).

```ts
// swap the backend — nothing else changes
import { sqliteCollections } from '@super-line/collections-sqlite'
createSuperLineServer(api, { /* … */, collections: sqliteCollections({ path: './data.db' }) })
```

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
