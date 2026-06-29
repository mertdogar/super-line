# @super-line/store-sync-pglite

Self-clustering **CRDT** Store for [**super-line**](https://mertdogar.github.io/super-line/) — durable, multi-node synced state with **no fan-out adapter**. Writes append a [Yjs](https://yjs.dev) delta to an append-only op-log in a central Postgres; [ElectricSQL](https://electric-sql.com) ships the op-log to each node's in-memory [PGlite](https://pglite.dev) replica, where every delta folds into a [super-store](https://www.npmjs.com/package/@super-store/store) doc. The CRDT sibling of [`@super-line/store-pglite`](https://www.npmjs.com/package/@super-line/store-pglite) (single-row LWW) — concurrent writers **merge** instead of clobbering.

```bash
pnpm add @super-line/store-sync-pglite @super-line/store-sync
```

> **ESM-only** (Node 18+). Needs a central Postgres and an [ElectricSQL](https://electric-sql.com) shape endpoint. Ships only the server half — the client reuses `syncStoreClient` from [`@super-line/store-sync`](https://www.npmjs.com/package/@super-line/store-sync).

```ts
// server — every node runs this; Postgres + Electric are the only shared infra, no adapter
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { syncPgliteStoreServer } from '@super-line/store-sync-pglite'
import { api } from './contract'
import { resolveOptions } from './scene' // shared with the client so both build each doc identically

const scene = await syncPgliteStoreServer({
  pgUrl: 'postgres://…/app',
  electricUrl: 'http://localhost:3000/v1/shape',
  resolveOptions,
})

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  stores: { scene }, // no `adapter` — Electric is the CRDT bus
})

// server-authoritative co-write (e.g. an AI agent): a reactive ServerReplica over the live doc
const replica = srv.store('scene').open('board', { origin: 'agent' })
replica.update({ title: 'hello' }) // → op-log row → Electric → every node merges
```

```ts
// client — the UNCHANGED CRDT client from @super-line/store-sync
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { syncStoreClient } from '@super-line/store-sync'
import { resolveOptions } from './scene'

const client = createSuperLineClient(api, {
  transport: webSocketClientTransport({ url: 'ws://localhost:8801' }),
  role: 'user',
  stores: { scene: syncStoreClient({ resolveOptions }) },
})
```

## How it works

- **CRDT, not LWW** — single-row + Electric can't merge (Electric ships whole rows; concurrent writers clobber). So the transport is an **append-only Yjs op-log**: every delta is an immutable `INSERT`. Each node folds the rows with `applyUpdate` (order-independent → convergence).
- **`clustering: 'self'`** — the store owns its cross-node sync (central Postgres + per-node Electric→PGlite replica), so it needs **no super-line Adapter**. Each node's `live.changes` folds incoming deltas into an in-memory doc and surfaces them through `ServerStore.onChange`, which core fans to that node's local subscribers. Strong ACL/existence reads hit central Postgres.
- **`open()` → `ServerReplica`** — a reactive handle over the live in-memory doc (`getSnapshot`/`subscribe`/`set`/`update`/`delete(path)`/`close`), the server-side co-writer. Works because the doc lives in memory (sync `getSnapshot`), the reason `store-pglite` deferred it.
- **Compaction** — folds the op-log down to a baseline row + a SQL-queryable `<table>.data` snapshot, bounding log growth. Debounced and eventually-consistent; safe under concurrent compactors (baselines are idempotent). Pass `compact: false` for a pure append-only log.

## Options

`await syncPgliteStoreServer(options)` → `Promise<ServerStore>`

| Option | Meaning |
| --- | --- |
| `pgUrl` | **Required.** Connection string for the central Postgres — source of truth for the op-log + strong ACL/existence. |
| `electricUrl` | Electric shape endpoint (e.g. `http://localhost:3000/v1/shape`). Omit to disable sync (tests feed the replica directly). |
| `table` | Table prefix: creates `<table>` (existence + ACL) and `<table>_updates` (the Yjs op-log). Default `'resources'`. |
| `resolveOptions` | `(id) => DocOptions \| undefined` — per-resource doc mode (`{ mode?: 'shallow' \| 'document', opaque?: string[] }`). Pass the **same** resolver to the client's `syncStoreClient` so both halves build each doc identically. |
| `compact` | `false` (pure append-only log) or `{ everyNUpdates?, debounceMs? }` (defaults `200` / `2000`ms). |
| `onError` | `(err, ctx) => void` — called when a background op-log append (a server co-write via `open()`) fails to persist. Defaults to `console.error`. |
| `db` | Advanced/testing: supply the local PGlite replica (needs the `live` extension; add `electricSync` for real sync). |

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guide: [synced state](https://mertdogar.github.io/super-line/guide/synced-state)
- 🧩 Example: [`ai-canvas-pglite`](https://github.com/mertdogar/super-line/tree/main/examples/ai-canvas-pglite)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
