# @super-line/store-sync-libsql

Durable CRDT [Store](https://mertdogar.github.io/super-line/guide/synced-state) for
[**super-line**](https://mertdogar.github.io/super-line/) — the Yjs merge engine from
[`@super-line/store-sync`](https://www.npmjs.com/package/@super-line/store-sync), snapshotted
per Resource to [libsql](https://github.com/tursodatabase/libsql) so synced state survives a
restart. Works against a local file, [Turso](https://turso.tech) Cloud, or a self-hosted `sqld`.

```bash
pnpm add @super-line/store-sync-libsql
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { libsqlSyncStore } from '@super-line/store-sync-libsql'
import { api } from './contract'

// ASYNC factory — it rehydrates every Resource from libsql before resolving,
// so you MUST await it before handing it to the server.
const store = await libsqlSyncStore({
  url: 'libsql://my-db.turso.io', // or 'file:state.db', ':memory:', 'http://localhost:8080'
  authToken: process.env.TURSO_AUTH_TOKEN, // Turso Cloud only
})

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  stores: { docs: store },
})
```

Pair it with the standard CRDT client half — [`syncStoreClient()`](https://www.npmjs.com/package/@super-line/store-sync):

```ts
import { syncStoreClient } from '@super-line/store-sync'
stores: { docs: syncStoreClient() }
```

## How it works

- **Durable CRDT** — this is `syncStoreServer`'s Yjs merge engine with persistence bolted on as an
  extra `onChange` subscriber. The hot path (`apply`) stays synchronous and relay-safe; the subscriber
  debounces a full-state upsert per Resource off the hot path.
- **History-preserving rehydrate** — on boot it reads every row and replays it via `applyUpdate`
  (not a fresh document), so Yjs history and merge identity survive the restart.
- **`clustering: 'relay'`** — like every CRDT/LWW store, changes fan out to other nodes over the
  server↔server [Adapter](https://mertdogar.github.io/super-line/guide/scaling-adapters). Add an
  adapter (Redis, libp2p, …) only when you scale past one process; libsql is durability, not the cluster bus.

## Options

`await libsqlSyncStore(options)`:

| Option | Meaning |
| --- | --- |
| `url` | **Required.** libsql URL: `file:x.db`, `:memory:`, `libsql://…` (Turso), or `http(s)://…` (self-hosted `sqld`). |
| `authToken` | Auth token for Turso Cloud. Omit for local files / unauthenticated `sqld`. |
| `table` | Table this store owns (default `'resources'`). Created if absent; validated `/^[A-Za-z_][A-Za-z0-9_]*$/`. |
| `debounceMs` | Coalesce rapid edits into one snapshot write (default `250`). |
| `resolveOptions` | Per-resource [`DocOptions`](https://mertdogar.github.io/super-line/guide/synced-state) `(id) => { mode, opaque } \| undefined`. **MUST match the client's** — the store-sync rule. |

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guide: [synced state (CRDT)](https://mertdogar.github.io/super-line/guide/synced-state) · [choosing a store](https://mertdogar.github.io/super-line/guide/choosing-a-store)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
