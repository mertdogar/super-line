# Self-clustering CRDT (Postgres + Electric)

[`@super-line/store-sync-pglite`](https://www.npmjs.com/package/@super-line/store-sync-pglite) is the one
[Store](./store) that is CRDT, durable, and clustered all at once — concurrent edits **merge** (true
multiplayer), state **survives a restart**, and it spans a **multi-node cluster with no message broker**.
Where a [`relay`](./choosing-a-store#relay-vs-self) store needs an [Adapter](./scaling-adapters) to fan
changes between nodes, this one is `self`-clustering: a central Postgres plus
[ElectricSQL](https://electric-sql.com) *is* the bus. You run no Redis, no RabbitMQ — no adapter at all.

It's the union of its two siblings:

| Store | Model | Durability | Clustering |
|---|---|---|---|
| [`store-sync`](./synced-state) | CRDT | in-memory | `relay` (needs an adapter) |
| [`store-pglite`](./store) | LWW | Postgres + Electric | `self` |
| **`store-sync-pglite`** | **CRDT** | **Postgres + Electric** | **`self`** |

`store-sync` gives you merge but loses state on restart and needs an adapter to scale out. `store-pglite`
is durable and self-clustering but **last-writer-wins** — concurrent edits to one Resource clobber.
`store-sync-pglite` is all three: merge *and* durable *and* broker-less.

## When to reach for it

Reach for it when **all three** are true at once:

1. Edits to one Resource must **merge** — a shared canvas, a collaborative document, an agent co-editing
   with users.
2. The state must **outlive a restart**.
3. You run **more than one node**, and you don't want to operate a message broker.

If you only need two of the three, a lighter sibling fits — see [Choosing a store](./choosing-a-store). And
if you *already* run an adapter (Redis, libp2p) for other reasons, a
[`relay`](./choosing-a-store#relay-vs-self) CRDT store — [`store-sync-libsql`](./synced-state#make-it-durable)
for durable, [`store-sync`](./synced-state) for in-memory — rides it with no extra infra. Reach for this one
specifically to **avoid** standing up a broker.

## Set it up

Install the server half and the shared CRDT engine. The client reuses `syncStoreClient` from
[`@super-line/store-sync`](./synced-state), so install that too:

```bash
pnpm add @super-line/store-sync-pglite @super-line/store-sync
```

Two pieces of infrastructure are shared by the whole cluster:

- **A central Postgres** — the source of truth for the op-log and for strong ACL / existence reads.
- **An [ElectricSQL](https://electric-sql.com) shape endpoint** (e.g. `http://localhost:3000/v1/shape`) —
  streams the Postgres tables into each node's replica.

Each node also owns an **in-memory [PGlite](https://pglite.dev) replica**, created for you — nothing to
provision. It's ephemeral: a node re-syncs it from Electric on boot.

::: warning Two infra prerequisites
Electric needs **logical replication** — run Postgres with `wal_level=logical` or Electric won't replicate.
And you run the **Electric service** ([`electricsql/electric`](https://electric-sql.com)) pointed at that
Postgres (its `DATABASE_URL`), with `ELECTRIC_INSECURE=true` for local dev. The minimal two-service setup is
in the example's
[`docker-compose.yml`](https://github.com/mertdogar/super-line/blob/main/examples/ai-canvas-pglite/docker-compose.yml).
:::

::: tip ESM-only, server-half only
The package is **ESM-only** (Node 18+) and ships **only the server half**. The wire is identical to any
CRDT store — opaque base64 Yjs deltas — so the client is the unchanged `syncStoreClient`.
:::

## The server half

Every node runs the same factory. `syncPgliteStoreServer` is an **async factory** (it opens the backend) —
`await` it — and you pass the result under `stores` with **no `adapter`**:

```ts
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { syncPgliteStoreServer } from '@super-line/store-sync-pglite'
import { api } from './contract'
import { resolveOptions } from './scene' // shared with the client, so both build each doc identically

const scene = await syncPgliteStoreServer({
  pgUrl: 'postgres://…/app',
  electricUrl: 'http://localhost:3000/v1/shape',
  resolveOptions,
})

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  stores: { scene }, // ← no `adapter`: Electric is the CRDT bus
})
```

::: tip No adapter, on purpose
A [`relay`](./choosing-a-store#relay-vs-self) store would need `adapter: redisAdapter(…)` (or libp2p,
RabbitMQ, …) to reach other nodes. A `self` store owns its cross-node sync, so the `adapter` key is simply absent. Mixing is
fine: a server can run `relay` stores over an adapter *and* `self` stores over Electric side by side. (See
[relay vs self](./choosing-a-store#relay-vs-self).)
:::

## The client half

The client is the **unchanged** `syncStoreClient` from [`@super-line/store-sync`](./synced-state) —
durability and clustering are server-side concerns the client never sees:

```ts
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

::: warning `resolveOptions` must match on both halves
If you pass `resolveOptions` to the server, pass the **same** resolver to the client's `syncStoreClient`.
Both peers build each Resource's Yjs document from it — its `mode` (`'shallow'` | `'document'`) and
`opaque` paths — and a mismatch makes the two docs disagree on structure. Share one module between client
and server (the examples import `./scene` on both sides). This is the standard
[synced-state](./synced-state) rule, not specific to this store.
:::

In React, `useResource` is identical to any store — you get the merged value and a write-through `set` /
`update`. See [React](./react).

::: tip Coming from another CRDT store?
Because the client and the wire are identical, switching from [`store-sync`](./synced-state) (in-memory) or
[`store-sync-libsql`](./synced-state#make-it-durable) (durable `relay`) is a **server-only swap** — replace
the store factory and drop the `adapter`. Existing Resources aren't auto-migrated into the op-log; re-seed
them with `create` / `open`.
:::

## How it works

The hard constraint is that **Electric ships whole rows, and whole rows can't merge** — if two nodes wrote
a Resource as one row, the last row Electric delivered would clobber the other. So `store-sync-pglite`
never syncs the *document*. It syncs an **append-only op-log of Yjs deltas**, and lets the CRDT do the
merging on each node:

```
  a write on any node
        |  append one Yjs delta (opaque base64)
        v
  ┌────────────────────────────────────────────────────┐
  │  central Postgres                                  │
  │    resources_updates  <-- append-only op-log       │
  └────────────────────────────────────────────────────┘
        |
        |  ElectricSQL streams every new row to EVERY node
        v
  ┌─── on each node ───────────────────────────────────┐
  │  PGlite replica  ->  live.changes                  │
  │       |                                            │
  │       v   fold (applyUpdate -- order-independent)  │
  │  in-memory Yjs doc                                 │
  │       |                                            │
  │       v   onChange                                 │
  │  this node's local subscribers (tabs / hooks)      │
  └────────────────────────────────────────────────────┘
```

Step by step:

1. **A write appends one immutable row.** A client edit — or a server co-write — becomes a single Yjs
   delta `INSERT` into `resources_updates`. Nothing is ever updated in place, so two concurrent writers
   simply produce two rows; neither overwrites the other.
2. **Electric streams the op-log to every node**, the writer included.
3. **Each node folds every delta** into a per-Resource in-memory Yjs doc with `applyUpdate`. Because
   `applyUpdate` is **order-independent and idempotent**, every node converges to the same document no
   matter what order the rows arrive in — that's the CRDT guarantee, now spanning the cluster.
4. **The fold fires `ServerStore.onChange`**, which super-line fans to that node's **local** subscribers —
   the browser tabs and React hooks connected to *this* node. Each node serves its own clients; Electric
   carries the cross-node hop.

Existence and ACL checks read **central Postgres** directly, so authorization is consistent even on a node
whose replica is still catching up — at the cost of a round-trip to the central DB on each `read()`. A
**write**, by contrast, isn't visible on other nodes until it round-trips Postgres → Electric → their
replica: usually sub-second, but **eventual, not synchronous** — don't expect cross-node read-your-write.
Echo-break — a writer never re-applying its own change — rides an `origin` column through the whole trip and
is automatic; you never wire it up.

::: tip The CRDT is opaque to the wire
super-line relays a CRDT `update` as an **opaque base64 delta** — it never parses the document. The merge
lives entirely inside the Yjs / [super-store](https://github.com/mertdogar/super-store) engine; Postgres
stores the deltas as text and Electric ships them as rows.
:::

## The server as a reactive co-writer

Because each node holds the canonical document **in memory**, the server can co-edit it in-process — open a
reactive [`ServerReplica`](./store#a-reactive-server-side-co-writer) and read and write the live merged
scene without a transport. This is the path for an **AI agent** editing the same board a browser user is
dragging:

```ts
const scene = srv.store('scene').open('board', { origin: 'agent:42' })

scene.subscribe(render) // sees users' merged edits, live — the reactive read side
scene.update({ title: 'hello' }) // merge a field → op-log row → Electric → every node merges
scene.delete(['shapes', id]) // surgically remove one key, merging with concurrent edits to others
scene.close()
```

Every mutation goes through the in-memory doc, whose update listener turns it into an op-log `INSERT`
stamped with this replica's `origin` — so a server co-write travels the same Postgres → Electric → fold
path as a client edit, and merges with everyone else's. `delete(path)` is the only way to remove a key from
a CRDT doc (since `update` merges); it's surgical, so a concurrent edit to a *different* key survives. It's
the same co-writer API as the [in-memory CRDT store](./synced-state#a-reactive-in-process-co-writer).

::: warning Strong-fold before co-writing on a node that didn't create the Resource
`open()` is synchronous — it hands back the node's in-memory doc as-is, and that doc is **empty until
Electric has streamed the Resource's op-log in**. On any node that didn't `create` the Resource, `await
srv.store('scene').read('board')` first: that folds the current state from central Postgres into the
in-memory doc, so the co-writer merges onto the real document instead of a blank one. (The
[`ai-canvas-pglite`](#run-it) server does exactly this before opening the agent's replica.)
:::

::: tip Only the CRDT self store can co-write in-process
`open()` returns a handle whose `getSnapshot` is **synchronous** — it reads the in-memory Yjs doc, not the
async Postgres driver. The LWW sibling [`store-pglite`](./store) has no in-memory document (it reads a
single row through the async driver), so it **can't** serve a synchronous snapshot and doesn't support
`open()`. The op-log's in-memory fold is exactly what makes a server co-writer possible here.
:::

::: warning Authority is reactive, not preventive
A CRDT can't reject *part* of a merge, so the server can't **veto** a client edit — it can only observe the
merged state and emit a compensating one. Route anything that needs a hard gate (money, permissions)
through a normal [request](./requests).
:::

A server co-write is **fire-and-forget**: `set` / `update` / `delete` return `void`, so the background
`INSERT` can't reject to the caller. A failed append surfaces through the `onError` option (default
`console.error`) — that's the only place a dropped server write is observable, so wire it up in production.

## Compaction

An append-only log grows forever, and a booting node would re-fold every delta since the beginning of time.
**Compaction** bounds it. A debounced background pass folds a Resource's log down to a single **baseline**
row (one full `encodeState()` that supersedes everything before it), materializes the folded document into
a SQL-queryable `<table>.data` column, and trims the rows it folded:

```ts
await syncPgliteStoreServer({
  pgUrl,
  electricUrl,
  resolveOptions,
  compact: { everyNUpdates: 200, debounceMs: 2000 }, // these are the defaults
})
// or compact: false  → a pure append-only log, never trimmed
```

Two payoffs:

- **The log stays bounded** — a fresh node re-folds from the latest baseline forward, not from row 1.
- **`<table>.data` holds the live board as plain JSON** — `SELECT data FROM resources WHERE id = 'board'`
  reads the current document without folding the log, which is handy for dashboards, exports, and
  debugging.

It's **eventually consistent and safe under concurrency**: any node may trigger a compaction, baselines are
idempotent, and the trim (`DELETE … <= maxSeq`) is commutative — so two nodes compacting the same Resource
at once is benign (worst case, one redundant baseline row) and no cross-node lock is needed.

## Options

`await syncPgliteStoreServer(options)` → `Promise<ServerStore>`

| Option | Default | Meaning |
|---|---|---|
| `pgUrl` | — | **Required.** Connection string for the central Postgres — the op-log + strong ACL / existence. |
| `electricUrl` | — | Electric shape endpoint (e.g. `http://localhost:3000/v1/shape`). Drives the replica and **all** `onChange` fan-out, so a real deployment always needs it — omitting it silently kills cross-node sync *and* local subscriptions. Omit only in tests that feed the replica directly. |
| `table` | `'resources'` | Table prefix. Creates `<table>` (existence + ACL + the `data` snapshot) and `<table>_updates` (the Yjs op-log). Must match `/^[A-Za-z_]\w*$/`. |
| `resolveOptions` | — | `(id) => DocOptions \| undefined` — per-Resource `mode` / `opaque` (return `undefined` for defaults). **Must match the client's** `syncStoreClient`. |
| `compact` | `{ everyNUpdates: 200, debounceMs: 2000 }` | Op-log compaction config, or `false` for a pure append-only log. |
| `onError` | `console.error` | `(err, ctx) => void` — called when a background op-log append (a server co-write) fails to persist. |
| `db` | — | Advanced / testing: supply the local PGlite replica (needs the `live` extension; add `electricSync` for real sync). |

## Deleting a Resource

`srv.store('scene').delete('board')` drops the whole Resource and tells **every node and every tab** it's
gone — the backend's own change feed (not an adapter) fans the deletion cluster-wide, and each open handle
flips its `deleted` flag. It's the standard
[deletion fan-out](./synced-state#deleting-a-whole-resource), and it works identically on a `self` store.

## Failure modes

The two infra dependencies fail differently — one loud, one silent — and it's worth knowing which:

- **Central Postgres unreachable** — *loud*. `read()`, ACL checks, and client writes (`apply`) go straight
  to Postgres, so they **reject to the caller** and the error surfaces.
- **Electric lagging or down** — *silent*. Writes still persist to Postgres, but stop reaching every node's
  replica, so the cluster keeps serving its **last-synced state with no error raised** — it degrades to
  *stale-but-available* and self-heals when Electric catches up. Monitor Electric's liveness yourself; a
  stalled stream is invisible from inside the store.

A failed **background co-write append** (through `open()`) is the third case — it can't reject to the caller,
so it surfaces only through [`onError`](#options).

## Run it

[**`ai-canvas-pglite`**](https://github.com/mertdogar/super-line/tree/main/examples/ai-canvas-pglite) is
this store end to end: a collaborative shape board with a **server-side AI agent as a co-writer**,
re-clustered across **two nodes** whose CRDT convergence rides Postgres + Electric instead of an adapter.
Drag shapes in one window, ask the agent ("add three blue circles, then delete the red one") in another,
and every edit merges on the same board across both nodes.

```bash
cp examples/ai-canvas-pglite/.env.example examples/ai-canvas-pglite/.env # add AI_GATEWAY_API_KEY
docker compose -f examples/ai-canvas-pglite/docker-compose.yml up --build
# node-1 → http://localhost:8200      node-2 → http://localhost:8200/?node=2
```

For the **LWW** sibling — single-row, same self-clustering infra — see
[`store-pglite`](https://github.com/mertdogar/super-line/tree/main/examples/store-pglite).

Next: [Choosing a store](./choosing-a-store) for the full menu · [Roles & auth](./roles-auth).
