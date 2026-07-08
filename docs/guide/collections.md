# Collections

A **Collection** is super-line's typed, relational persisted-state primitive: a named set of **rows**,
each validated against a schema you declare **on the contract**. Unlike a [Store](./store) — one opaque
JSON document per id — a collection is a table: many small rows you filter, subscribe to in subsets, join,
and secure per-row. It's the relational successor to the last-writer-wins Store family (see
[ADR-0006](https://github.com/mertdogar/super-line/blob/main/docs/adr/0006-collections-are-on-contract-typed-rows.md)).

The division of labor is the whole idea:

- **super-line is the server-authoritative sync source.** It owns the rows, validates every write against
  the contract schema, enforces row-level security, and streams each caller exactly the subset it's allowed
  to see — live.
- **[TanStack DB](https://tanstack.com/db) is the client query engine.** Joins, live queries, and
  optimistic mutations run in the browser over the synced rows, via the first-party
  [`@super-line/tanstack-db`](#tanstack-db-the-query-engine) adapter. super-line does not ship a query engine
  of its own.

::: tip Collections vs Stores — rows vs documents
Use a **collection** for tabular data: messages, users, tasks — anything you'd filter, paginate, join, or
secure per-row. Use a **[Store](./store)** for a single collaborative document (a canvas, a rich-text doc)
where concurrent edits must **merge** — that's the CRDT family, and it stays off-contract because a merge
delta can't be schema-validated. Rows = collections; documents = stores.
:::

## Declare collections on the contract

Collections live in `defineContract`, alongside your roles — a top-level `collections` block. Each entry is
a Standard Schema (Zod/Valibot/ArkType), the primary-key field, and optional advisory foreign keys:

```ts
import { defineContract } from '@super-line/core'
import { z } from 'zod'

export const api = defineContract({
  collections: {
    users: { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' },
    messages: {
      schema: z.object({
        id: z.string(),
        channelId: z.string(),
        authorId: z.string(),
        text: z.string(),
        createdAt: z.number(),
      }),
      key: 'id',
      references: { authorId: 'users' }, // advisory FK: messages.authorId → users
    },
  },
  roles: { user: { clientToServer: { /* … */ } } },
})
```

Both ends import this one definition, so row types flow end-to-end with no codegen — `RowOf<typeof api, 'messages'>`
is `{ id, channelId, authorId, text, createdAt }` on the server handle, the client handle, and the TanStack
collection. **The server validates every row write against the schema** — the end-to-end-types-plus-validate-every-message
promise, restored for row data.

## Server: a backend + row policies

Give the server **one** collection backend (it serves every collection — a single transaction domain, so
cross-collection batches are atomic) and a **row policy** per collection:

```ts
import { createSuperLineServer } from '@super-line/server'
import { memoryCollections } from '@super-line/collections-memory'
import { isIn } from '@super-line/core'

const srv = createSuperLineServer(api, {
  transports: [/* … */],
  authenticate: (h) => ({ role: 'user' as const, ctx: { userId: h.query.userId, channels: [/* … */] } }),
  identify: (conn) => conn.ctx.userId,
  collections: memoryCollections(),
  policies: {
    users: { read: () => undefined, write: () => true }, // world-readable directory
    messages: {
      // `read` returns a filter ANDed into every snapshot AND live change for this caller:
      read: (principal, ctx) => isIn('channelId', ctx.channels), // you only ever see your channels
      // `write` guards each row op:
      write: (principal, op, next, prev) =>
        op === 'delete' ? prev?.authorId === principal : next?.authorId === principal, // author-only
    },
  },
})
```

Policies are **deny-by-default**: a collection with no `read` policy can't be read by clients, and no `write`
policy means no client writes. Return `undefined` from `read` to allow the whole collection. This is the
server-authoritative half TanStack can't do on its own — row-level security enforced at the source.

::: warning Policy staleness
`read` is evaluated **at subscribe time**. Principal-side state captured there (e.g. the caller's channel
list) goes stale until the client resubscribes; row-side predicates (`channelId in …`) re-evaluate on every
change naturally. If a caller's visibility changes, have them resubscribe.
:::

Server code can co-write, bypassing policy (but still schema-validated) — the door for business-logic
mutations a request handler owns:

```ts
await srv.collection('messages').insert({ id: 'm1', channelId: 'general', authorId: 'system', text: 'welcome', createdAt: Date.now() })
```

## Client: subscribe to subsets, mutate in batches

`client.collection(name)` is typed by the contract. `subscribe(query)` opens a **live row-set** — an initial
snapshot, then per-row change events, auto-resubscribed and re-diffed across reconnects:

```ts
const messages = client.collection('messages')
const sub = messages.subscribe({ filter: eq('channelId', 'general'), orderBy: [{ field: 'createdAt', dir: 'asc' }], limit: 50 })
await sub.ready
sub.rows()                    // current rows, ordered + limited
sub.subscribe((ev) => { /* { type: 'insert'|'update'|'delete', id, row } */ })

await messages.insert({ id: 'm2', channelId: 'general', authorId: 'me', text: 'hi', createdAt: Date.now() })
await messages.batch([        // one atomic batch, all-or-nothing on the server
  { type: 'update', row: { /* … */ } },
  { type: 'delete', id: 'm1' },
])
```

The subscription carries a small **query IR** — `filter` (`and`/`or`/`not`, `eq`/`neq`/comparisons/`in`/`like`),
`orderBy`, `limit`/`offset` — built with the helpers exported from `@super-line/core`. The server pushes down
what it can and re-checks the exact predicate; the client re-filters too, so an over-approximate result is
always safe. `orderBy`/`limit` shape the **initial snapshot**; the live phase streams every matching change and
the consumer owns its window.

::: tip The primitive is non-optimistic
`client.collection(name)` is the raw sync layer: a write appears in `rows()` when the server confirms it.
Optimism — instant local application, rollback on error — is TanStack DB's job, layered on top via the
adapter. Await `sub.ready` before you depend on live delivery.
:::

### React

`useCollection` is a thin, typed filtered-list hook for simple cases; point joins and complex live queries at
TanStack:

```tsx
const { rows, insert, update, delete: del } = useCollection('messages', { filter: eq('channelId', id) })
```

## TanStack DB: the query engine

For joins and live queries, hand a super-line collection to TanStack DB via
[`@super-line/tanstack-db`](https://www.npmjs.com/package/@super-line/tanstack-db):

```ts
import { createCollection, createLiveQueryCollection, eq } from '@tanstack/db'
import { superLineCollectionOptions } from '@super-line/tanstack-db'

const users = createCollection(superLineCollectionOptions(client, api, 'users'))
const messages = createCollection(superLineCollectionOptions(client, api, 'messages', { query: { filter: eq('channelId', 'general') } }))

// a client-side join, denormalizing author names onto messages — updates incrementally as rows sync
const feed = createLiveQueryCollection((q) =>
  q.from({ m: messages })
    .join({ u: users }, ({ m, u }) => eq(u.id, m.authorId), 'inner')
    .select(({ m, u }) => ({ id: m.id, text: m.text, author: u.name })),
)
```

The adapter derives `getKey` from the contract, maps each TanStack transaction to one atomic super-line batch
(the ack resolves the optimistic commit; an error rolls it back), and translates TanStack's query predicates
into the super-line IR — pushing per-query subsets to the server so only the rows you query cross the wire. In
React, use `useLiveQuery` from `@tanstack/react-db` with the same query builder.

## Backends

One backend serves all of a server's collections. Three ship today, varying on durability and clustering
exactly like the store family:

| Package | Durability | Clustering |
|---|---|---|
| **`@super-line/collections-memory`** | in-memory | `relay` |
| **`@super-line/collections-sqlite`** | SQLite (better-sqlite3, WAL) | `relay` |
| **`@super-line/collections-pglite`** | central Postgres + Electric→PGlite | **`self`** |

`relay` backends replicate over the server↔server [adapter](./scaling-adapters) (each node a full replica);
the `self` backend owns a central Postgres and a per-node Electric-synced replica and needs **no adapter**.
`collections-sqlite` compiles the query IR to SQL to narrow snapshots; `collections-pglite` is the collection
analogue of [`store-pglite`](./choosing-a-store). All three are drop-in — swapping is a one-line change.

## CRDT document collections

Some state doesn't want to be a row table — a collaborative canvas, a rich-text doc, a scene graph. Those
want **merge** (two people editing different fields converge) rather than last-writer-wins. Collections cover
this too: a **CRDT document collection** is one `collection(n)` concept away from a row collection, declared
with a `crdt` key instead of a `key`:

```ts
const contract = defineContract({
  collections: {
    messages: { schema: messageSchema, key: 'id' },                 // LWW rows (queryable)
    scenes:   { schema: sceneSchema, crdt: { mode: 'document' } },   // CRDT docs (opened by id)
  },
})
```

A CRDT collection is **opened by id, not queried** — `collection(n).open(id)` returns a reactive document
handle (`getSnapshot`/`subscribe`/`set`/`update`/`delete`), and concurrent edits merge instead of clobbering.
Unlike the old off-contract doc stores, **the schema is enforced**: every write is validated *before it
commits* — the server merges the incoming delta onto a scratch copy, snapshots it to plaintext, validates
against the contract schema, and only then commits and fans it out. An invalid write is rejected server-side
and never reaches other clients.

::: warning Keep CRDT schemas tolerant
Validation runs against the *post-merge* state, which a concurrent merge can leave **momentarily incomplete** —
an overwrite of a field is internally a delete-then-insert, and under interleaved cross-node folds the delete
can land a beat before the insert. Two consequences:

- **Aggregate constraints** (`maxItems`, cross-field invariants) can reject an honest writer under concurrency —
  put those in a request handler, not the schema.
- **A required field that is concurrently overwritten can transiently be absent.** If the schema hard-requires
  it, that transient state is rejected, the writer resyncs, and the resync churn can diverge the document's Yjs
  lineage until the field is dropped for good — permanently wedging the collection (every later write then fails
  the same check).

So for any field that is concurrently mutated, prefer `z.number().catch(0)` / `.optional()` over a bare
`z.number()`: validation coerces a transient gap to a default instead of rejecting, and the next write restores
the real value. Reserve strict/required only for fields written once and never concurrently overwritten.
:::

```ts
// server
createSuperLineServer(contract, {
  crdtCollections: crdtMemoryCollections(),        // the CRDT backend (a backend per family)
  policies: {
    scenes: {                                       // guard-shaped, deny-by-default
      read:  (principal, id, snapshot) => snapshot?.ownerId === principal,
      write: (principal, id) => true,
    },
  },
})
await srv.collection('scenes').create('board', { shapes: {} })  // creation is server-authoritative

// client
const client = createSuperLineClient(contract, {
  transport, role: 'user',
  crdtCollections: crdtCollectionsClient(),         // the universal client engine
})
const doc = client.collection('scenes').open('board')
await doc.ready
doc.update({ title: 'hello' })                      // merges + syncs to every open handle
// react: const { data, update } = useDoc('scenes', 'board')
```

**Backends** (same durability/clustering axes as row collections):

| Package | Durability | Clustering |
|---|---|---|
| **`@super-line/collections-crdt-memory`** | in-memory | `relay` |
| **`@super-line/collections-crdt-libsql`** | libsql / Turso (snapshot-per-doc) | `relay` |

`collections-crdt-memory` also exports the universal `crdtCollectionsClient()` — one client engine pairs with
every backend tier (the client only merges opaque deltas). Creation is server-only: clients open existing
documents, and a client-initiated create routes through a request handler.

**Rows or docs?** Reach for a **row collection** when you want to query/filter/join across many records
(messages, users, orders). Reach for a **CRDT document collection** when one resource is edited concurrently
and must merge (a canvas, a document, a shared config). Both live under `collection(n)`, both are typed and
validated on the contract.

## Advisory foreign keys

`references` on a contract collection is metadata: it feeds the Control Center schema graph and the TanStack
adapter's join hints. Turn on an opt-in existence check with `checkReferences: true` on the server — an
insert/update whose reference points at a missing row is then rejected. It's **advisory**: best-effort under
`relay` clustering (no global serialization point), with no cascades, and it doesn't resolve intra-batch
parent-then-child references. For strict integrity, use a `self` backend or route the write through a request
handler.

## Run it

- [`examples/collections`](https://github.com/mertdogar/super-line/tree/main/examples/collections) — a
  runnable tsx tracer: RLS pushdown, a `messages ⋈ users` join, and optimistic writes with rollback, in
  ~120 lines against a real server.
- [`examples/collections-chat`](https://github.com/mertdogar/super-line/tree/main/examples/collections-chat)
  — a full Slack-like React app: four collections (users/channels/memberships/messages), per-channel
  row-level security with a join gate, optimistic sends, and the Control Center Collections view. The
  relational counterpart to [`advanced-chat-app`](https://github.com/mertdogar/super-line/tree/main/examples/advanced-chat-app)
  (same UI on the LWW `store-sqlite`).

## See also

- [Choosing a store](./choosing-a-store) — collections vs the doc-store families
- [Control Center](./control-center) — the Collections view: schema graph + row browser
- [The contract](./the-contract) · [React](./react)
