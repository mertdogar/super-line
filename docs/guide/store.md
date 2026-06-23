# Stores

A **Store** is super-line's persisted-state primitive: a permissioned, real-time collection of JSON
**Resources** (`{ id, accessRules, data }`). The server is authoritative — it creates Resources, grants
and revokes access per client, and validates every read/write — while clients get a reactive handle that
catches up to the current state and stays live.

Like a [transport](./transports), a Store is **pluggable** and ships as a **server + client pair** you
pass at construction. Two implementations ship today — *one plumbing, two consistency models*:

- **`@super-line/store-memory`** — last-writer-wins, in-memory. The zero-dependency default.
- **`@super-line/store-sync`** — a merging **CRDT** Store backed by [super-store](https://github.com/mertdogar/super-store)
  (Yjs). Concurrent writes to different fields converge instead of clobbering; for true multiplayer.

Both expose the same `…StoreServer()` / `…StoreClient()` pair, so switching consistency models is a
one-line swap at construction — the wire, ACLs, fan-out, and client handle are identical.

::: tip Off-contract by design
Unlike requests, events, and topics, a Store is **not** declared in `defineContract`, and its `data` is
**not** schema-validated by the server — a CRDT update is an opaque merge delta that can't be validated
against a JSON schema anyway. You get a generic, permissioned document store; route anything needing a
hard, typed gate through a normal [request](./requests). (See ADR-0003 in the repo.)
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

// client
import { memoryStoreClient } from '@super-line/store-memory'
const client = createSuperLineClient(api, {
  transport: webSocketClientTransport({ url }),
  role: 'user',
  params: { uid: 'alice' },
  stores: { docs: memoryStoreClient() },
})
```

For a collaborative, merging store, swap the pair for the CRDT one — nothing else changes:

```ts
import { syncStoreServer } from '@super-line/store-sync' // server: stores: { docs: syncStoreServer() }
import { syncStoreClient } from '@super-line/store-sync' // client: stores: { docs: syncStoreClient() }
```

## Server-authoritative access

The server owns Resources. `create` / `grant` / `revoke` are **server-side only** — clients can't create
Resources or change access; they read and write only within granted bounds. Access is **deny-by-default**:
a principal absent from a Resource's `accessRules` gets nothing. Permissions are checked against the
**principal** — the `identify(conn)` key (stable across reconnects), or the random `conn.id` when `identify`
isn't set.

```ts
await srv.store('docs').create(
  'note-1',
  { title: 'Draft', body: '' },
  { alice: { read: true, write: true }, bob: { read: true, write: false } },
)
await srv.store('docs').grant('note-1', 'carol', { read: true, write: false })
await srv.store('docs').revoke('note-1', 'bob')
await srv.store('docs').write('note-1', { title: 'Curated', body: '' }) // server co-write
```

An unpermitted read returns `NOT_FOUND`; an unpermitted write returns `FORBIDDEN`.

## The reactive handle

On the client, `open(id)` returns a handle: a snapshot that fills in after catch-up, live updates, and
`set` / `update` that write through. It **re-snapshots automatically on reconnect**.

```ts
const note = client.store('docs').open('note-1')
await note.ready // catch-up complete
console.log(note.getSnapshot()) // { title: 'Draft', body: '' }

const off = note.subscribe(() => render(note.getSnapshot()))
note.update({ title: 'Shipping plan' }) // optimistic locally, fanned to other subscribers

// one-shot sugar, no handle:
const value = await client.store('docs').read('note-1')
await client.store('docs').write('note-1', { title: 'x', body: '' })
```

In React, [`useResource`](./react) wraps all of this:

```tsx
const { data, set, update } = useResource<Note>('docs', 'note-1')
```

## Scaling & observability

- **Cross-node.** Each Store declares a clustering mode. `relay` (the in-memory store) is node-local:
  super-line relays changes across nodes over the [adapter](./scaling-adapters) and converges each node's
  replica — no extra wiring. `self` stores own a shared backend (Redis/Postgres) and super-line stays out
  of their cross-node sync. Echo-break (a writer never re-applies its own change) is automatic.
- **Control Center.** With `inspector: true`, store traffic surfaces as `store.write` / `store.grant` /
  `store.revoke` / `store.subscribe` events under the **Store** filter, payloads safe-snapshotted and
  `inspector.redact`-masked like every other message.

## Running it

The [`store` example](https://github.com/mertdogar/super-line/tree/main/examples/store) is a permissioned
note: two users open it, one writes and the other sees it live, a read-only user is denied a write, a
third user can't open until the server grants access, and the server co-writes — all over the in-memory
LWW Store.

Next: [Synced state (CRDT)](./synced-state) — the merging Store for true multiplayer.
