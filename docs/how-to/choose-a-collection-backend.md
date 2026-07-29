# Choose a collection backend

A **backend** decides where [collection](/collections/) state lives, how durable it is, and how it reaches other nodes. There are **two seams**, and you pick each one independently:

- `collections:` — the [row collection](/collections/row-collections) backend (last-writer-wins rows).
- `crdtCollections:` — the [CRDT document collection](/collections/crdt-documents) backend (documents whose concurrent edits merge).

Both are one-line swaps, and mixing tiers is normal — durable rows on SQLite next to in-memory documents is a perfectly good development setup.

::: tip A backend is not an adapter
These are different axes and easy to conflate. A **backend** is where collection state *lives*. An **[adapter](/how-to/choose-an-adapter)** is the server↔server substrate that fans broadcasts out between nodes. A `relay` backend *uses* the adapter to replicate its writes; a `self` backend owns its own replication and needs **no adapter at all**. For the full model, see [transports vs. adapters](/concepts/transports-and-adapters).
:::

## Start here

If you want the answer and not the reasoning:

| Your situation | Rows (`collections:`) | Documents (`crdtCollections:`) |
| --- | --- | --- |
| One node; state may vanish on restart | `memoryCollections()` | `crdtMemoryCollections()` |
| One node; state must survive a restart | `sqliteCollections(…)` | `await crdtLibsqlCollections(…)` |
| Several nodes that must **coordinate** | `await pgliteCollections(…)` | `await crdtPgliteCollections(…)` |

Start on memory. It is the zero-dependency default and it is not a toy — it applies batches atomically and replicates across a cluster like every other `relay` backend. Move off it when state must outlive the process.

## The two questions that decide it

**1. Must state survive a restart?** If no, take a memory backend and stop reading. If yes, you need a durable tier.

**2. Do your nodes need to _coordinate_, or only _converge_?** This is the question the package names don't ask for you, and it's the one that matters at more than one node.

- **Converge** means every node ends up holding the same rows. Two nodes can accept writes independently and settle into agreement afterwards. Every backend does this.
- **Coordinate** means the cluster enforces something *at the moment of the write* — two nodes competing for one job slot, a claim only one worker may win, a conditional write that must see a globally-current row. This needs a single serialization point, and only the `self` tier has one.

super-line names this on the backend itself as `coordination`, alongside `clustering`:

| | `coordination: 'local'` | `coordination: 'cluster'` |
| --- | --- | --- |
| Backends | memory · sqlite | pglite |
| Conditional writes are checked | per node | across the whole cluster |
| Two nodes racing for one slot | both can win | exactly one wins |

If you only ever run one process, `local` and `cluster` are the same thing and you should pick on durability alone.

## Decision tree

```
must collection state survive a restart?
│
├─ no ──▶ memory
│         collections-memory · collections-crdt-memory
│
└─ yes ─▶ more than one node?
          │
          ├─ no ──▶ sqlite / libsql
          │         collections-sqlite · collections-crdt-libsql
          │
          └─ yes ─▶ must the nodes coordinate, or only converge?
                    │
                    ├─ converge ───▶ sqlite / libsql + an adapter
                    │                (a node-local file each; no backfill)
                    │
                    └─ coordinate ─▶ pglite
                                     collections-pglite · collections-crdt-pglite
                                     (Postgres + Electric; no adapter)
```

## Row backends at a glance

| Package | Durability | Clustering | Coordination | Reach for it when |
| --- | --- | --- | --- | --- |
| **`@super-line/collections-memory`** | in-memory | `relay` | `local` | development, tests, and any state you're content to rebuild on boot |
| **`@super-line/collections-sqlite`** | SQLite file (WAL) | `relay` | `local` | one node whose state must survive a restart — the common single-server production pick |
| **`@super-line/collections-pglite`** | central Postgres + Electric→PGlite | **`self`** | **`cluster`** | several nodes that must agree at write time, not merely eventually |

```ts
// the backend is the only line that changes
import { sqliteCollections } from '@super-line/collections-sqlite'

createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  collections: sqliteCollections({ file: './data.db', collections: api.collections }),
})
```

The two SQL backends need the contract's post-merge `collections` map, because each collection gets its own typed table derived from its schema. `memoryCollections()` takes no arguments at all. See [backends & clustering](/collections/backends) for every option and the query-pushdown rules.

## CRDT backends at a glance

| Package | Durability | Clustering | Reach for it when |
| --- | --- | --- | --- |
| **`@super-line/collections-crdt-memory`** | in-memory | `relay` | development and tests; also exports the client engine every tier pairs with |
| **`@super-line/collections-crdt-libsql`** | libsql / Turso, snapshot per document | `relay` | durable documents on one node, local file or hosted Turso |
| **`@super-line/collections-crdt-pglite`** | central Postgres Yjs op-log + Electric→PGlite | **`self`** | documents shared across a cluster with no adapter |

CRDT backends expose `clustering` but **no `coordination` flag** — there are no conditional writes to serialize, because merge *is* the conflict-resolution model. The choice here is durability and reach, nothing more.

Whichever tier you pick, the client always uses the same engine — it only merges opaque deltas, so it doesn't care what the server persists to:

```ts
import { crdtCollectionsClient } from '@super-line/collections-crdt-memory'

createSuperLineClient(api, {
  transport: webSocketClientTransport({ url }),
  role: 'user',
  crdtCollections: crdtCollectionsClient(), // universal — pairs with every backend tier
})
```

## What you actually have to operate

The real cost difference between tiers is infrastructure, not API surface.

| Backend | What you must run | Notes |
| --- | --- | --- |
| memory · crdt-memory | **nothing** | no dependencies, no files, no services |
| sqlite | a writable file path | `better-sqlite3` is a native module — it needs a prebuild matching your Node version, or a toolchain to compile from source at install |
| crdt-libsql | a file, or a Turso/sqld endpoint | `file:x.db` needs no service; `libsql://` or `http(s)://` points at hosted Turso or your own sqld |
| pglite · crdt-pglite | **Postgres + Electric** | Postgres must run with `wal_level=logical`; an [Electric](https://electric-sql.com) service streams shapes to each node's local replica |

The `self` tier is two services, and that is the honest price of cluster-wide coordination. In exchange it needs no super-line adapter — Postgres and Electric *are* the fan-out. The [`queue-cluster`](https://github.com/mertdogar/super-line/tree/main/examples/queue-cluster) and [`ai-canvas-pglite`](https://github.com/mertdogar/super-line/tree/main/examples/ai-canvas-pglite) examples both boot the whole thing with Docker Compose if you'd rather read a working file than assemble one.

## Two traps

### A relay backend does not backfill a node that joins

`relay` clustering fans **live batches** across the adapter. It does not transfer existing state to a node that starts up. A node begins with whatever its own local store already holds and converges only from that moment forward:

- **memory** — a restarted node comes back **empty**, and stays empty for every row written before it booted. Nothing re-sends them.
- **sqlite** — a restarted node comes back with its own file, which is missing everything written while it was down.

This is fine for a single node (nothing to diverge from) and fine for state that is naturally re-created — presence, ephemeral sessions, a cache. It is a genuine hazard for long-lived rows on a multi-node relay deployment. If nodes come and go and must all see the full history, use the `self` tier, where each node's replica is fed from the central Postgres and a fresh node syncs the current state on connect.

::: warning Give each relay node its own file
Don't point two nodes at one SQLite file on a shared volume. A relay backend expects a **node-local** store: every node applies each relayed batch to its own copy, so a shared file gets the same batch applied once per node. If you want one shared database, that's the `self` tier, not a shared file.
:::

### `coordination: 'local'` makes conditional writes per-node

On memory and sqlite, a conditional write is checked against *that node's* rows. Two nodes can each find a condition satisfied and both proceed. This is exactly why [`plugin-queue`](/how-to/plugin-queue) coordinates through the **collection backend** rather than the adapter: its slots, claims, leases and cron ticks are conditional writes, so on a `local` backend each node keeps its own private set of them regardless of which adapter you add. Only `pgliteCollections` makes configured concurrency cluster-wide. See [run queues across a cluster](/how-to/queue-clusters).

Adding an adapter does **not** upgrade `local` to `cluster`. The adapter shortens wake-up latency and carries topology; it is not a serialization point.

## Mixing the two seams

The seams are independent, so pick each on its own merits. A durable single-node server with collaborative documents:

```ts
import { sqliteCollections } from '@super-line/collections-sqlite'
import { crdtLibsqlCollections } from '@super-line/collections-crdt-libsql'

createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  collections: sqliteCollections({ file: './rows.db', collections: api.collections }),
  crdtCollections: await crdtLibsqlCollections({
    url: 'file:docs.db',
    docOptions: (n) => api.collections[n]?.crdt,
  }),
})
```

At the `self` tier the two backends pair naturally, since they can share one Postgres and one Electric service:

```ts
collections: await pgliteCollections({ pgUrl, electricUrl, collections: api.collections }),
crdtCollections: await crdtPgliteCollections({ pgUrl, electricUrl, docOptions: (n) => api.collections[n]?.crdt }),
```

Note the async factories: every durable tier except SQLite returns a promise, because it opens a connection and rehydrates before it can serve a read.

## Next

- [Backends & clustering](/collections/backends) — the full capability matrix, every factory option, and the SQL pushdown rules.
- [Row-level security & policies](/collections/policies) — how routing respects `read` filters, whichever backend you chose.
- [Choose an adapter](/how-to/choose-an-adapter) — the server↔server fan-out a `relay` backend rides.
- [Run queues across a cluster](/how-to/queue-clusters) — why the queue plugin's correctness depends on this page's choice.
