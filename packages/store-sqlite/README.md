# @super-line/store-sqlite

Durable, last-writer-wins **Store** server half for
[**super-line**](https://mertdogar.github.io/super-line/) — the in-memory
[`memoryStoreServer`](https://www.npmjs.com/package/@super-line/store-memory), but backed by
SQLite ([better-sqlite3](https://github.com/WiseLibs/better-sqlite3), WAL) so Resources survive a
restart.

```bash
pnpm add @super-line/store-sqlite
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { sqliteStoreServer } from '@super-line/store-sqlite'
import { api } from './contract'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  stores: {
    chat: sqliteStoreServer({ file: './chat.db' }), // ':memory:' for an ephemeral store
  },
})
```

Pair it with [`memoryStoreClient()`](https://www.npmjs.com/package/@super-line/store-memory) on the
client (or [`useResource`](https://www.npmjs.com/package/@super-line/react) in React) — same
namespace, same Resources, now persisted.

## How it works

- **Durable LWW** — each Resource is one row (`id`, `data`, `access` as JSON). A write replaces the
  whole `data` (last-writer-wins). Opened with `journal_mode = WAL` + `synchronous = NORMAL`, so the
  store survives process restarts.
- **`clustering: 'relay'`** — the store does no networking. super-line core relays its Changes across
  nodes over the server↔server [Adapter](https://mertdogar.github.io/super-line/guide/scaling-adapters)
  and feeds remote Changes back in. Run one adapter per cluster; a single node needs none.
- **Server-side writes** — `srv.store('chat').open(id)` returns a `ServerReplica` whose
  `set`/`update`/`delete(path)` co-write straight to SQLite and fan out to subscribers.
- **Deletion** — `srv.store('chat').delete(id)` removes the row and fans the deletion cluster-wide
  (the `sdel` wire frame); clients see `ResourceHandle.deleted` / `useResource().deleted` flip.

## Options

| Option | Meaning |
| --- | --- |
| `file` | Path to the SQLite database file. Use `':memory:'` for an ephemeral store. |
| `table` | Table this store owns (default `resources`). Use distinct tables to share one file across stores. |

## Example

- 🧩 [`advanced-chat-app`](https://github.com/mertdogar/super-line/tree/main/examples/advanced-chat-app) — a Slack-like chat (React 19 + Tailwind + shadcn) with channels and history persisted to SQLite.

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guide: [stores](https://mertdogar.github.io/super-line/guide/store)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
