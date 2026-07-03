# Synced state (CRDT)

The default [Store](./store) is **last-writer-wins**: when two clients edit the same Resource at once,
the last write to land wins — and clobbers the other, *even if they touched different fields*. For true
multiplayer, reach for **`@super-line/store-sync`**: a [CRDT](https://crdt.tech) Store where concurrent
writes **merge** instead of overwriting. It's backed by Yjs (via
[super-store](https://github.com/mertdogar/super-store)), but you never touch Yjs directly — the ACLs,
the handle, and `useResource` are exactly the same as the LWW store. Only the consistency model changes.

## The one-line swap

`store-sync` is the same server + client pair as any [Store](./store) — swap it in by name, change
nothing else:

```ts
// server — was: stores: { docs: memoryStoreServer() }
import { syncStoreServer } from '@super-line/store-sync'
stores: { docs: syncStoreServer() }
```

```ts
// client — was: stores: { docs: memoryStoreClient() }
import { syncStoreClient } from '@super-line/store-sync'
stores: { docs: syncStoreClient() }
```

`syncStoreServer()` takes no options; `syncStoreClient()` takes an optional `{ origin }` — a per-writer
id used to break echoes, generated for you if you omit it.

## What merge buys you

With LWW, two simultaneous edits race and one loses. With the CRDT store they **converge** — both edits
survive on every replica:

```ts
// alice and bob open the same doc, then edit
// at the "same time", each a different field:
alice.update({ a: 1 })
bob.update({ b: 2 })

// LWW:  whoever lands last wins
//       → { a: 1 } OR { b: 2 } — one edit is lost
// CRDT: both merge everywhere
//       → { a: 1, b: 2 } on alice, bob, and the server
```

Fields nobody touched are preserved, and the document converges to the same value on every node
regardless of the order updates arrive in. That's the whole reason to pay for a CRDT.

::: tip How it stays CRDT-agnostic
On the wire, a CRDT `update` is an **opaque base64 delta** — super-line relays it without ever parsing
the document. The merge logic lives entirely inside the store package, so swapping Yjs for another CRDT
would be a store-package change, not a wire change.
:::

## The server as a co-writer

The server holds the **canonical** copy of every Resource — which makes it the place to persist state,
and lets it edit alongside clients. A server `write` of a partial object **merges** its top-level keys
into the document (it doesn't replace it), then fans out to every subscriber tagged `origin: 'server'`:

```ts
// a co-writer contributes a field; every other
// field in the doc is left untouched
await srv.store('docs').write('plan', { priority: 5 })
```

::: tip Authority is reactive, not preventive
A CRDT can't reject *part* of a merge, so the server can't **veto** a client edit — as the hub it can
only **react**: observe the merged state and emit a compensating edit. Treat synced-document authority
as eventually-consistent last-word correction; route anything that needs a hard gate (money,
permissions) through a normal [request](./requests).
:::

### A reactive in-process co-writer

`write` is fire-and-forget, and a merge can only **add or change** keys — it can't express a key
*removal*. For a server-side co-writer that reads the live merged document and edits it over time — an
AI agent driving the same scene as a browser user, say — open a reactive handle instead. It runs
in-process over the canonical document, so it reads reactively and writes without a transport:

```ts
const scene = srv.store('docs').open('plan', { origin: 'agent:42' })

// the reactive read side — sees the user's merged edits, live
scene.subscribe(render)

scene.update({ priority: 5 }) // merge a field
scene.delete(['draft']) // remove a key, merging with edits to other keys
scene.close()
```

`delete(path)` is the only way to remove a key from a CRDT document, since `update` and `write` merge.
It's **surgical**: it removes just that key, so a concurrent edit to a *different* key still survives
the merge — the same convergence guarantee as any other edit. Because the handle reads and writes the
canonical document in-process, a delete is atomic and never clobbers a concurrent edit. (Across nodes a
`relay` store resolves a delete last-writer-wins, like every write — see [Scaling](./scaling-adapters).)

The same `delete(path)` is on the **client** handle, so a browser can remove one element without a
full-document `set` — which would otherwise clobber a peer's concurrent edits to other elements. Reach
for `update` to add or change, `delete(path)` to remove, and `set` only for a genuine whole-document
replace.

## Deleting a whole Resource

`delete(path)` removes a *key*. To drop the **entire Resource** — and tell every node and every tab it's
gone — delete it on the server:

```ts
await srv.store('docs').delete('plan')
```

This fans an `sdel` frame out **cluster-wide** (over the [Adapter](./scaling-adapters) for a `relay`
store, or the backend's own change feed for a [`self`](./choosing-a-store) store). Every open handle
flips its `deleted` flag to `true` and notifies subscribers, so a consumer can tell "gone" apart from
"empty document":

```ts
const h = client.store('docs').open('plan')
h.subscribe(() => {
  if (h.deleted) showTombstone()
})
```

In React it's a field on the hook:

```tsx
const { data, deleted } = useResource('docs', 'plan')
if (deleted) return <p>this doc was deleted</p>
```

## Catch-up & reconnect

`open(id)` seeds the replica from the server's current canonical state — the full CRDT document, sent
once — then merges live deltas on top. On reconnect the handle **re-seeds automatically**. Like events
and topics, live delivery is **at-most-once**: a client that was offline misses the deltas it didn't
receive and recovers by re-snapshotting on reconnect (which the handle does for you).

## Make it durable

`syncStoreServer()` keeps the canonical CRDT documents in memory — restart the server and they're gone.
For state that **survives a restart**, swap the server half for `@super-line/store-sync-libsql` (a `relay`
store), or — to survive a restart *and* cluster across nodes with no message broker — for the `self`-clustering
[`@super-line/store-sync-pglite`](./store-sync-pglite). The libsql route
snapshots every Resource to a [libsql](https://github.com/tursodatabase/libsql) database — a local file,
[Turso](https://turso.tech) Cloud, or a self-hosted `sqld`:

```bash
npm install @super-line/store-sync-libsql
```

```ts
// server — durable drop-in for syncStoreServer()
import { libsqlSyncStore } from '@super-line/store-sync-libsql'

stores: {
  docs: await libsqlSyncStore({ url: 'file:docs.db' }), // local file
  // or Turso: libsqlSyncStore({
  //   url: 'libsql://your-db.turso.io',
  //   authToken: process.env.TURSO_TOKEN,
  // })
}
```

The client stays `syncStoreClient()` — durability is a server-half concern, so the wire and the merge
model are unchanged. `libsqlSyncStore` is an **async factory** (`await` it): on boot it rehydrates every
Resource from the DB before the store is ready, replaying each saved document with a history-preserving
`applyUpdate` — so the CRDT keeps converging across the restart instead of resetting to a fresh root.

| option | default | what it does |
| --- | --- | --- |
| `url` | — | libsql URL: `file:x.db`, `:memory:`, `libsql://` (Turso) or `http(s)://` (sqld) |
| `authToken` | — | auth token for Turso Cloud |
| `table` | `'resources'` | the table this store owns (must match `/^[A-Za-z_]\w*$/`) |
| `debounceMs` | `250` | coalesce rapid edits into one snapshot write |
| `resolveOptions` | — | per-Resource `DocOptions` — **must match the client's** (the store-sync rule) |

Persistence is **snapshot-per-resource**: each Resource is one row holding its full merged state,
upserted off the hot path and debounced per id, so a burst of edits collapses into a single write. The
`apply` hot path stays synchronous and relay-safe — persistence is just an extra `onChange` subscriber.

For the full menu — LWW vs CRDT, memory vs SQLite vs libsql vs Postgres, `relay` vs `self` clustering —
see [Choosing a store](./choosing-a-store).

## In React

Nothing changes from the LWW store — [`useResource`](./react) gives you the merged value and a
write-through `set` / `update`:

```tsx
const { data, set } = useResource<JsonValue>('docs', 'plan')
if (data === undefined) return <p>connecting…</p>
// every edit merges live across tabs — concurrent
// edits to different fields both survive
return <JsonEditor value={data} onChange={set} height={420} />
```

## Run it

The [`store-sync-json` example](https://github.com/mertdogar/super-line/tree/main/examples/store-sync-json)
is a collaborative JSON editor over the CRDT Store: a [`@visual-json`](https://visual-json.dev) editor
bound to one shared Resource via `useResource`. Open it in two tabs (or add `?name=bob`), edit any
field, and watch edits merge live — concurrent edits to *different* fields both survive. Hit **Server
nudge** to see the server co-write a field.

```bash
# serves http://localhost:5273
pnpm --filter @super-line/example-store-sync-json dev
```

## Roll your own (without the Store seam)

`store-sync` is the batteries-included path. If you'd rather own the wire — custom rooms, your own
message shapes, no Store abstraction — super-line is also a fine **transport** for a CRDT you drive
yourself. Keep a CRDT document per room and relay its opaque update bytes over a shared event: the bus
never parses the document, and the server holds the canonical copy (so it can persist and co-write).
This is, in effect, what the CRDT Store does for you under the hood.

Three messages carry it: a `joinDoc` request that returns the current state to catch up, a `pushUpdate`
request for local edits, and a shared `update` event to fan merges out — with an `origin` tag to break
the echo.

```ts
defineContract({
  shared: {
    serverToClient: {
      update: { payload: z.object({ docId: z.string(), update: z.string(), origin: z.enum(['peer', 'server']) }) },
    },
  },
  roles: {
    user: {
      clientToServer: {
        joinDoc: { input: z.object({ docId: z.string() }), output: z.object({ snapshot: z.string() }) },
        pushUpdate: { input: z.object({ docId: z.string(), update: z.string() }), output: z.object({ ok: z.boolean() }) },
      },
    },
  },
})
```

On the server, materialize one document per room and make the doc's own update observer the single
fan-out + persist point — it fires for **both** client merges and the server's own edits, so the server
co-writes just by mutating the doc. On the client, push only locally-originated updates and apply
everything else. (CRDT updates are binary and super-line's default serializer is JSON, so base64-wrap
them — `btoa` / `atob` are global in the browser and modern Node.)

The [`synced-canvas-yjs`](https://github.com/mertdogar/super-line/tree/main/examples/synced-canvas-yjs)
and [`synced-canvas-automerge`](https://github.com/mertdogar/super-line/tree/main/examples/synced-canvas-automerge)
examples implement this end to end — a collaborative canvas where tabs *and* the server co-edit one
document, with a debug panel logging each patch by origin. (The contract above is the Yjs example's; the
Automerge one ships an array of change blobs per edit instead of a single update — but the relay pattern
is identical, because super-line never parses the bytes either way.)

```bash
pnpm --filter @super-line/example-synced-canvas-yjs dev         # Yjs
pnpm --filter @super-line/example-synced-canvas-automerge dev   # Automerge
```

Next: [Roles & auth](./roles-auth).
