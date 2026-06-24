# Stores

A **Store** is super-line's persisted-state primitive: a named, permissioned collection of JSON
**Resources** — each a `{ id, accessRules, data }` record. The server is authoritative: it creates
Resources, grants and revokes per-client access, and validates every read and write. Clients get a
**reactive handle** that catches up to the current value and stays live.

Like a [transport](./transports), a Store is **pluggable** and ships as a **server + client pair** you
pass at construction. Two implementations ship today — *one plumbing, two consistency models*:

- **`@super-line/store-memory`** — last-writer-wins, in-memory, zero-dependency. The default.
- [**`@super-line/store-sync`**](./synced-state) — a merging **CRDT** Store (Yjs via
  [super-store](https://github.com/mertdogar/super-store)). Concurrent writes to different fields
  converge instead of clobbering — for true multiplayer.

Both expose the same `…StoreServer()` / `…StoreClient()` pair, so switching consistency models is a
one-line swap — the wire, ACLs, fan-out, and client handle are identical.

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

Both stores that ship support `open`. Its `set` / `update` / `delete` fan out to subscribers exactly
like a client write, and `origin` (default `"server"`) tags each change for echo-break and Control
Center attribution. `update` and `write` **merge** top-level keys, so they can add or change a key but
never remove one — `delete(path)` is the only server-side key removal. On the CRDT store, that delete
is surgical and merges with concurrent edits to other keys; see [Synced state](./synced-state).

The [`ai-canvas` example](https://github.com/mertdogar/super-line/tree/main/examples/ai-canvas) is a
full showcase: a server-side LLM agent co-edits a shared canvas through `open(id)` — reading the live
board and driving it with tools mapped onto `update` (add/move/recolor) and `delete(path)` (remove),
merging with users' concurrent edits.

- **Cross-node.** Each Store declares a clustering mode. `relay` (both stores that ship) is node-local:
  super-line relays every change across nodes over the [adapter](./scaling-adapters) and converges each
  node's replica — no extra wiring. A `self` store owns a shared backend (Redis/Postgres) and handles
  its own cross-node sync; super-line stays out of it. Echo-break — a writer never re-applies its own
  change — is automatic in both modes.
- **Control Center.** With `inspector: true`, store traffic surfaces as `store.write` / `store.grant` /
  `store.revoke` / `store.subscribe` events under the **Store** filter. The write payload — the only one
  carrying arbitrary user data — is safe-snapshotted and `inspector.redact`-masked like every other
  message. (See [Control Center](./control-center).)

## Run it

The [`store` example](https://github.com/mertdogar/super-line/tree/main/examples/store) is a permissioned
note over the in-memory LWW Store: two users open it, one writes and the other sees it live, a read-only
user is denied a write, a third user can't open until the server grants access at runtime, and the server
co-writes.

```bash
pnpm --filter @super-line/example-store start
```

Next: [Synced state (CRDT)](./synced-state) — the merging Store for true multiplayer.
