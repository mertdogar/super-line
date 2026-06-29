# @super-line/store-pglite

Self-clustering, last-writer-wins **Store** for [**super-line**](https://mertdogar.github.io/super-line/) —
a central **Postgres** is the source of truth, each node mirrors it into an in-memory **PGlite** replica via
[**ElectricSQL**](https://electric-sql.com), and `live.changes` becomes `onChange` / `onDelete` fanned to that
node's **local** connections only. The first `clustering: 'self'` store: cross-node sync is owned by the store,
so it needs **no super-line adapter** — Postgres + Electric is the only fan-out infra.

```bash
pnpm add @super-line/store-pglite
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { pgliteStoreServer } from '@super-line/store-pglite'
import { api } from './contract'

const store = await pgliteStoreServer({
  pgUrl: process.env.PG_URL!, // central Postgres — writes + strong reads + ACL
  electricUrl: process.env.ELECTRIC_URL, // Electric shape endpoint streaming into the local replica
})

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  stores: { docs: store },
})
```

```ts
// client — pair with the in-memory relay client
import { memoryStoreClient } from '@super-line/store-memory'

const client = createSuperLineClient(api, {
  transport: webSocketClientTransport({ url }),
  stores: { docs: memoryStoreClient() },
})
```

No adapter — point every node at the same Postgres + Electric and run identical code with no cluster-size
knowledge. A write round-trips `node → Postgres → Electric → every node's replica`; the `origin` column carries
super-line's echo-break through the round-trip so the writer doesn't re-receive its own change.

## How it works

- **Writes / strong reads / ACL** → the central Postgres via `postgres.js`. It owns the `resources` table.
- **Subscriptions** → each node's in-memory PGlite replica, kept current one-way by Electric, surfaced through
  `live.changes` and turned into `onChange` (insert/update) / `onDelete`. Core fans those to LOCAL connections
  only (`clustering: 'self'`).
- **No adapter** — the store never touches super-line's server↔server adapter; Postgres + Electric is the entire
  fan-out plane. (A relay store like [`@super-line/store-sqlite`](https://www.npmjs.com/package/@super-line/store-sqlite)
  fans changes over the adapter instead.)
- **Deletion fan-out** — `srv.store('docs').delete(id)` deletes the central row; Electric streams the delete to
  every replica → `onDelete` → clients see `ResourceHandle.deleted` / `useResource().deleted`.

## Options

| Option | Meaning |
| --- | --- |
| `pgUrl` | Connection string for the central Postgres — source of truth for writes, strong reads, and ACL. |
| `electricUrl` | Electric shape endpoint (e.g. `http://localhost:3000/v1/shape`) streaming the central table into this node's replica. Omit to disable incoming sync (tests / manual replica feeding). |
| `table` | Table this store owns on both the central DB and the local replica (default `resources`). |
| `db` | Advanced/testing: supply the local PGlite replica (needs the `live` extension; add `electricSync` for real sync). Omitted → an ephemeral in-memory PGlite is created. |

`pgliteStoreServer` is an **async factory** — `await` it before passing to `stores`.

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guide: [stores](https://mertdogar.github.io/super-line/guide/store)
- 🧩 Example: [`store-pglite`](https://github.com/mertdogar/super-line/tree/main/examples/store-pglite)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
