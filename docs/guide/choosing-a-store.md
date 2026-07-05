# Choose your store

::: tip Tabular data? Reach for Collections first
This page covers the **document** stores — one opaque JSON blob per id. For **tabular** data (messages,
users, tasks — anything you'd filter, paginate, join, or secure per-row), use
[**Collections**](./collections): typed rows declared on the contract, subset subscriptions, row-level
security, and [TanStack DB](https://tanstack.com/db) for client-side joins. Collections are the successor to
the LWW (last-writer-wins) document stores below, which are now deprecated. The CRDT stores remain the right
tool for a single collaborative document.
:::

A [**Store**](./store) is super-line's persisted-state primitive — a named collection of permissioned
JSON **Resources** the server owns and clients read/write through a reactive handle. Like a
[transport](./transports) or an [adapter](./scaling-adapters), a Store is **pluggable** and ships as a
server + client pair you pass at construction. Six ship today, and they vary on three independent axes:

- **Consistency model** — **LWW** (last-writer-wins: the last write to land clobbers the rest) or
  **CRDT** (concurrent writes to different fields **merge** instead of clobbering — true multiplayer,
  Yjs via [super-store](https://github.com/mertdogar/super-store)).
- **Durability** — where the canonical state lives: **in-memory** (gone on restart), a durable
  **SQLite** / **libsql-Turso** backend, or a central **Postgres** streamed to each node by Electric.
- **Clustering** — how a change reaches other nodes: **`relay`** (super-line relays it over the
  server↔server [adapter](./scaling-adapters)) or **`self`** (the store owns a central backend + a
  per-node replica and syncs itself — **no adapter needed**).

The wire, ACLs, deletion fan-out, and the reactive handle are **identical** across all six, so changing
store is mostly a one-line swap of the server half.

## Which store?

| Store | Model | Durability | Clustering | Client half |
|---|---|---|---|---|
| [`@super-line/store-memory`](./store) | LWW | in-memory | `relay` | `memoryStoreClient` |
| [`@super-line/store-sync`](./synced-state) | CRDT | in-memory | `relay` | `syncStoreClient` |
| [`@super-line/store-sqlite`](./store) | LWW | SQLite file (better-sqlite3, WAL) | `relay` | `memoryStoreClient` |
| [`@super-line/store-sync-libsql`](./synced-state) | CRDT | libsql / Turso / sqld | `relay` | `syncStoreClient` |
| [`@super-line/store-pglite`](./store) | LWW | Postgres (central) + Electric→PGlite | `self` | `memoryStoreClient` |
| [`@super-line/store-sync-pglite`](./store-sync-pglite) | CRDT | Postgres (central) + Electric→PGlite | `self` | `syncStoreClient` |

**Only the server half varies.** Durability and clustering are server-side concerns — the client never
knows where state is persisted, only which consistency model it speaks. So there are just **two client
halves**: pair any LWW server with `memoryStoreClient`, any CRDT server with `syncStoreClient`.

```ts
// LWW — pair the server half with memoryStoreClient
memoryStoreServer()                                    // in-memory
sqliteStoreServer({ file: 'data.db' })                 // durable — SQLite (WAL)
await pgliteStoreServer({ pgUrl, electricUrl })        // self-clustering — Postgres + Electric→PGlite

// CRDT — pair the server half with syncStoreClient
syncStoreServer()                                      // in-memory
await libsqlSyncStore({ url: 'libsql://…' })           // durable — libsql / Turso / sqld
await syncPgliteStoreServer({ pgUrl, electricUrl })    // self-clustering — op-log + Electric→PGlite
```

The libsql and PGlite server factories are **async** (they open the backend) — `await` them. For the
CRDT durable/self stores, a `resolveOptions: (id) => DocOptions` passed to the server **must match** the
one on `syncStoreClient` — both peers have to agree on each Resource's `mode` (`'shallow'` | `'document'`)
and `opaque` paths. See [Synced state](./synced-state).

## Which do I pick?

- **Just getting started, or ephemeral state** → **`store-memory`**. Zero dependencies, the default.
- **Multiplayer** — concurrent edits to one Resource must merge, not clobber → a CRDT store; start with
  **`store-sync`**.
- **State must survive a restart, single backend, LWW** → **`store-sqlite`**.
- **State must survive a restart, multiplayer** → **`store-sync-libsql`** (a managed/edge SQLite via
  Turso; snapshot-per-resource, history-preserving rehydrate).
- **A multi-node cluster with no message broker to run** → a **`self`** store: **`store-pglite`** (LWW)
  or **`store-sync-pglite`** (CRDT). Central Postgres + Electric is the fan-out; you add **no**
  [adapter](./scaling-adapters).
- **A multi-node cluster you already run an adapter for** (Redis, libp2p, …) → any **`relay`** store; it
  rides your existing backbone with no extra wiring.

## relay vs self

Every store declares a clustering mode; super-line picks the right fan-out automatically:

- **`relay`** (`store-memory`, `store-sync`, `store-sqlite`, `store-sync-libsql`) — node-local backend.
  super-line relays every change across nodes over the [adapter](./scaling-adapters) and converges each
  node's replica. One process needs no adapter at all; add a backbone only when you scale out.
- **`self`** (`store-pglite`, `store-sync-pglite`) — the store owns a central Postgres and a per-node
  Electric-synced PGlite replica and does its own cross-node sync, so it needs **no adapter**. See
  [Stores → cross-node](./store).

Echo-break — a writer never re-applies its own change — is automatic in both modes.

::: tip Deletion fans out everywhere
`srv.store(ns).delete(id)` publishes cluster-wide on every store; subscribers see it as
`ResourceHandle.deleted` on the client and [`useResource().deleted`](./react) in React — not a silent
empty snapshot. (Server-side: `ServerStore.onDelete`.)
:::

## Run it

- The [`store` example](https://github.com/mertdogar/super-line/tree/main/examples/store) — permissioned
  notes over the in-memory LWW Store.
- [`advanced-chat-app`](https://github.com/mertdogar/super-line/tree/main/examples/advanced-chat-app) —
  a Slack-like app with channels and history persisted to **`store-sqlite`**.
- [`store-pglite`](https://github.com/mertdogar/super-line/tree/main/examples/store-pglite) and
  [`ai-canvas-pglite`](https://github.com/mertdogar/super-line/tree/main/examples/ai-canvas-pglite) —
  the **`self`**-clustering stores: central Postgres + Electric→PGlite, no adapter.

Next: [Stores](./store) for the full model · [Synced state (CRDT)](./synced-state) for multiplayer.
