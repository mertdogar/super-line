# Stores

A **Store** is super-line's persisted-state primitive: a named, permissioned collection of JSON
**Resources** — each a `{ id, accessRules, data }` record. The server is authoritative: it creates
Resources, grants and revokes per-client access, and validates every read and write. Clients get a
**reactive handle** that catches up to the current value and stays live.

Like a [transport](./transports), a Store is **pluggable** and ships as a **server + client pair** you
pass at construction. **Six stores ship today**, varying along two axes — the **consistency model**
(last-writer-wins vs a merging CRDT) and **durability + clustering** (where state lives, and how a change
crosses nodes):

| Package | Model | Durability | Clustering | Client pair |
|---|---|---|---|---|
| **`@super-line/store-memory`** | LWW | in-memory | relay | `memoryStoreClient()` |
| [**`@super-line/store-sync`**](./synced-state) | CRDT | in-memory | relay | `syncStoreClient()` |
| **`@super-line/store-sqlite`** | LWW | SQLite (better-sqlite3, WAL) | relay | `memoryStoreClient()` |
| [**`@super-line/store-sync-libsql`**](./synced-state) | CRDT | libsql / Turso / sqld | relay | `syncStoreClient()` |
| **`@super-line/store-pglite`** | LWW | central Postgres + Electric→PGlite | **self** | `memoryStoreClient()` |
| **`@super-line/store-sync-pglite`** | CRDT | central Postgres op-log + Electric→PGlite | **self** | `syncStoreClient()` |

Every store exposes the same `…StoreServer()` / `…StoreClient()` pair, so switching consistency model,
durability, or clustering is a one-line swap — the wire, ACLs, fan-out, and client handle are identical. A
**LWW** server pairs with `memoryStoreClient()`; a **CRDT** server pairs with `syncStoreClient()`. The
**relay** vs **self** clustering distinction has its own [section below](#clustering-relay-vs-self). See
[**Choosing a store**](./choosing-a-store) for the full decision matrix.

::: tip Off-contract by design
Unlike requests, events, and topics, a Store is **not** declared in `defineContract`, and its `data`
is **not** schema-validated by the server — a CRDT update is an opaque merge delta that can't be
validated against a JSON schema anyway. Store `data` is `unknown` end-to-end; you assert its shape.
Route anything that needs a hard, typed gate through a normal [request](./requests). (See ADR-0003.)
:::

## Configure the pair

Pass matching server and client halves, keyed by name. Each name is an independent backend with its own
consistency model and persistence — so one app can mix a CRDT `scene` store and an LWW `config` store.

```ts
// server
import { memoryStoreServer } from '@super-line/store-memory'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid } }),
  identify: (conn) => conn.ctx.uid, // the ACL principal (falls back to conn.id)
  stores: { docs: memoryStoreServer() },
})
```

```ts
// client
import { memoryStoreClient } from '@super-line/store-memory'

const client = createSuperLineClient(api, {
  transport: webSocketClientTransport({ url }),
  role: 'user',
  params: { uid: 'alice' },
  stores: { docs: memoryStoreClient() }, // same name as the server
})
```

The client key **must match** the server key — `store('docs')` throws `NOT_FOUND` if the name isn't
configured on that side. To go collaborative, swap the pair for the CRDT one; nothing else changes:

```ts
import { syncStoreServer } from '@super-line/store-sync' // server: stores: { docs: syncStoreServer() }
import { syncStoreClient } from '@super-line/store-sync' // client: stores: { docs: syncStoreClient() }
```

To make it **durable**, swap only the server half for a backend that persists — the client half is
unchanged (LWW keeps `memoryStoreClient()`, CRDT keeps `syncStoreClient()`):

```ts
// LWW → durable SQLite (better-sqlite3, WAL). `table?` lets several stores share one file.
import { sqliteStoreServer } from '@super-line/store-sqlite'
// server: stores: { docs: sqliteStoreServer({ file: 'data.db' }) }

// CRDT → durable libsql/Turso/sqld. Async factory — it rehydrates every Resource before resolving.
import { libsqlSyncStore } from '@super-line/store-sync-libsql'
// server: stores: { docs: await libsqlSyncStore({ url: 'libsql://…', authToken }) }
```

`libsqlSyncStore` is an **async factory**: it rehydrates each Resource from libsql (history-preserving
`applyUpdate`) before returning a ready store, then snapshots each Resource's CRDT state on a debounce
(`debounceMs`, default 250ms). As with any CRDT pair, pass the same `resolveOptions` to both halves so the
per-Resource doc modes match — see [Synced state](./synced-state).

## Server-authoritative access

The server owns Resources. `create` / `grant` / `revoke` / `delete` are **server-side only** — there's
no client wire for them, so clients can't create Resources or change access; they read and write only
within granted bounds. Access is **deny-by-default**: a principal absent from a Resource's `accessRules`
gets nothing.

Permissions key off the **principal** — `identify(conn)` (stable across reconnects), or the random
`conn.id` when `identify` isn't set. (It's the same hook [presence](./introspection-and-presence) uses.)

```ts
const docs = srv.store('docs')

await docs.create(
  'note-1',
  { title: 'Draft', body: '' },
  { alice: { read: true, write: true }, bob: { read: true, write: false } },
)

await docs.grant('note-1', 'carol', { read: true, write: false }) // open access at runtime
await docs.revoke('note-1', 'bob') // remove it
await docs.write('note-1', { title: 'Curated', body: '' }) // server co-write (origin 'server')

const res = await docs.read('note-1') // Resource | undefined (server admin read, no ACL)
const ids = await docs.list() // string[]
await docs.delete('note-1')
```

The wire ops a **client** can attempt are read/subscribe and write — each ACL-checked against its
principal:

| Client attempt | When it fails | Error |
|---|---|---|
| `open` / `read` a Resource | principal lacks `read` | `FORBIDDEN` |
| `write` a Resource | principal lacks `write` | `FORBIDDEN` |
| any op on an unknown id | the Resource doesn't exist | `NOT_FOUND` |
| `store(name)` | the name isn't configured | `NOT_FOUND` |

## The reactive handle

On the client, `open(id)` returns a handle: a snapshot that fills in after catch-up, live updates, and
`set` / `update` that write through optimistically. It **re-snapshots automatically on reconnect**.

```ts
const note = client.store('docs').open('note-1')
await note.ready // catch-up complete; getSnapshot() is undefined until then
console.log(note.getSnapshot()) // { title: 'Draft', body: '' }

const off = note.subscribe(() => render(note.getSnapshot()))
note.update({ title: 'Shipping plan' }) // optimistic locally, fanned to other subscribers
note.set({ title: 'Reset', body: '' }) // replace the whole value
note.delete(['body']) // surgically remove a key by path (merges, unlike a full-value set)
off()
note.close() // drops the server subscription when the last handle for this id closes
```

Writes are **optimistic and fire-and-forget**: the local value changes immediately, then the change is
sent up. If the server rejects it (e.g. `FORBIDDEN`), there's no automatic rollback — the rejection is
routed to `onStoreError`, and the local replica reconciles on the next remote change or re-seed:

```ts
const client = createSuperLineClient(api, {
  // …
  stores: { docs: memoryStoreClient() },
  onStoreError: (err, { store, id }) => console.warn('write denied', store, id, err),
})
```

For a one-shot read or write with no handle:

```ts
const value = await client.store('docs').read('note-1') // Promise<unknown>
await client.store('docs').write('note-1', { title: 'x', body: '' }) // Promise<void>
```

In React, [`useResource`](./react) wraps all of this — open, subscribe, write-through, and close on
unmount:

```tsx
const { data, set, update, delete: remove } = useResource<Note>('docs', 'note-1')
// data is undefined until catch-up; set replaces, update merges a partial, delete removes a key by path
```

## A reactive server-side co-writer

`write` is the one-shot server co-write. When a server-side actor needs to **read reactively and edit
over time** — an AI agent, a moderation bot, a validator, a scheduled job — open a reactive handle with
`srv.store(name).open(id)`. It's the server-half mirror of the client's `open(id)`: it runs in-process
over the canonical state, so it's server-authoritative (no ACL) and needs no transport.

```ts
const note = srv.store('docs').open('note-1', { origin: 'agent:42' }) // origin tags its writes

note.getSnapshot()                    // the live canonical value
const off = note.subscribe(redraw)    // fires on every client edit — the reactive read side
note.update({ title: 'Curated' })     // merge a co-write
note.delete(['body'])                 // remove a key — the only way to delete server-side (see below)
note.set({ title: 'Reset', body: '' }) // replace the whole value
off()
note.close()                          // release the subscription
```

Every store supports `open` except **`store-pglite`** (its LWW self backend can't serve a synchronous
snapshot from the async driver; its CRDT sibling `store-sync-pglite` does, over its in-memory doc). Its
`set` / `update` / `delete` fan out to subscribers exactly like a client write, and `origin` (default
`"server"`) tags each change for echo-break and Control Center attribution. `update` and `write` **merge**
top-level keys, so they can add or change a key but never remove one — `delete(path)` is the only
server-side key removal. On a CRDT store, that delete is surgical and merges with concurrent edits to
other keys; see [Synced state](./synced-state).

The [`ai-canvas` example](https://github.com/mertdogar/super-line/tree/main/examples/ai-canvas) is a
full showcase: a server-side LLM agent co-edits a shared canvas through `open(id)` — reading the live
board and driving it with tools mapped onto `update` (add/move/recolor) and `delete(path)` (remove),
merging with users' concurrent edits.

## Clustering: relay vs self

Every Store declares a **clustering mode** that decides how a change on one node reaches the others.
Echo-break — a writer never re-applies its own change — is automatic in both.

**`relay`** — store-memory, store-sync, store-sqlite, store-sync-libsql. Each node keeps its own replica;
super-line relays every applied Change across nodes over the [server↔server adapter](./scaling-adapters)
and converges each replica. No extra wiring — if you already run an adapter for events and topics, relay
stores ride the same bus.

**`self`** — store-pglite, store-sync-pglite. The store owns a shared backend and its own cross-node sync,
so it needs **no adapter at all**. `pgliteStoreServer` writes to a central **Postgres** (the source of
truth for writes, strong reads, and ACL) and mirrors that table into each node's in-memory **PGlite**
replica over **Electric** (one-way, read-only). The replica's `live.changes` feed becomes
`ServerStore.onChange` / `onDelete`, which core fans to that node's local subscribers. A write
round-trips central PG → Electric → every node's `live.changes`, and an `origin` column carries
echo-break through the trip — so Postgres + Electric *is* the fan-out infra, with nothing for super-line's
adapter to do.

```ts
import { pgliteStoreServer } from '@super-line/store-pglite'

// server — no adapter needed
stores: {
  docs: await pgliteStoreServer({
    pgUrl: 'postgres://…',                         // central source of truth
    electricUrl: 'http://localhost:3000/v1/shape', // streams the table into this node's replica
  }),
}
// client: stores: { docs: memoryStoreClient() } — LWW, same client half as store-memory
```

`store-sync-pglite` is the CRDT sibling. Because Electric ships whole rows (which can't merge), it syncs
an append-only Yjs **op-log** (`<table>_updates`) instead — every delta is an immutable INSERT that
Electric streams to every node, each folding it into an in-memory super-store doc (`compact` bounds the
log; `onError` surfaces a failed background append). That live in-memory doc is also what lets this self
store support [`open()` / `ServerReplica`](#a-reactive-server-side-co-writer). Pair it with
`syncStoreClient()`.

## Deleting Resources

`srv.store(name).delete(id)` removes a Resource everywhere. The backend drops it, then the delete fans
**cluster-wide**: a `relay` store publishes a wire `sdel` frame (`SDeleteFrame`) over the
adapter; a `self` store's backend signals the delete on every node (surfaced through `ServerStore.onDelete`,
the delete-side mirror of `onChange`). Either way, each node pushes `sdel` to the clients subscribed to
that Resource. (This is whole-Resource removal — to drop a single *key* and keep the Resource, use
`delete(path)` on a [handle](#a-reactive-server-side-co-writer).)

On the client, an open handle exposes a **`deleted`** flag, so a deletion is observable instead of a silent
empty snapshot:

```ts
const note = client.store('docs').open('note-1')
note.subscribe(() => {
  if (note.deleted) showGone() // the Resource was deleted server-side
  else render(note.getSnapshot())
})
```

In React, [`useResource`](./react) surfaces the same signal:

```tsx
const { data, deleted } = useResource<Note>('docs', 'note-1')
if (deleted) return <Gone />
```

## Run it

The [`store` example](https://github.com/mertdogar/super-line/tree/main/examples/store) is a permissioned
note over the in-memory LWW Store: two users open it, one writes and the other sees it live, a read-only
user is denied a write, a third user can't open until the server grants access at runtime, and the server
co-writes.

```bash
pnpm --filter @super-line/example-store start
```

Next: [Synced state (CRDT)](./synced-state) — the merging Store for true multiplayer.
