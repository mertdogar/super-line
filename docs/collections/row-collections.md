# Row collections

A **row collection** is a table: many small rows, each validated against a schema you declare on the contract. You filter them, subscribe to subsets, mutate them in atomic batches, and secure them per row. This is the common case — messages, users, tasks, orders.

> New to collections? Start with [the overview](/collections/) for the rows-vs-documents split, or build one hands-on in [Tutorial 2](/tutorials/first-collection).

## Declare rows on the contract

Each entry is a [Standard Schema](https://standardschema.dev) (Zod/Valibot/ArkType), the primary-key field, and optional advisory foreign keys:

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

Row types flow end-to-end with no codegen — `RowOf<typeof api, 'messages'>` is `{ id, channelId, authorId, text, createdAt }` on the server handle, the client handle, and the TanStack collection. **The server validates every row write against the schema.**

## Give the server a backend

Hand the server **one** collection backend — it serves every collection, in a single transaction domain, so cross-collection batches are atomic. Pair it with a [row policy](/collections/policies) per collection (deny-by-default):

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
      read: (principal, ctx) => isIn('channelId', ctx.channels), // you only ever see your channels
      write: (principal, op, next, prev, ctx) =>
        op === 'delete' ? prev?.authorId === principal : next?.authorId === principal, // author-only
    },
  },
})
```

The `read`/`write` policies are the server-authoritative half a client query engine can't do on its own — [row-level security](/collections/policies) enforced at the source. Which backend you pick (in-memory, SQLite, or the self-clustering Postgres tier) is a [one-line swap](/collections/backends).

Server code can **co-write**, bypassing policy but still schema-validated — the door for business-logic mutations a request handler owns:

```ts
await srv.collection('messages').insert({
  id: 'm1', channelId: 'general', authorId: 'system', text: 'welcome', createdAt: Date.now(),
})
```

## Client: subscribe to subsets, mutate in batches

`client.collection(name)` is typed by the contract. `subscribe(query)` opens a **live row-set** — an initial snapshot, then per-row change events, auto-resubscribed and re-diffed across reconnects:

```ts
import { eq } from '@super-line/core'

const messages = client.collection('messages')
const sub = messages.subscribe({
  filter: eq('channelId', 'general'),
  orderBy: [{ field: 'createdAt', dir: 'asc' }],
  limit: 50,
})
await sub.ready                 // frames process concurrently — await before you depend on live delivery
sub.rows()                      // current rows, ordered + limited
sub.subscribe((ev) => { /* { type: 'insert'|'update'|'delete', id, row } */ })

await messages.insert({ id: 'm2', channelId: 'general', authorId: 'me', text: 'hi', createdAt: Date.now() })
await messages.batch([          // one atomic batch, all-or-nothing on the server
  { type: 'update', row: { /* … */ } },
  { type: 'delete', id: 'm1' },
])
```

::: tip Await `sub.ready`
The subscription's frames process concurrently, so `sub.ready` is the barrier before you can trust live delivery. This is a hard rule for the raw sync layer.
:::

## The query IR

The subscription carries a small **query IR** — `filter` (`and`/`or`/`not`, `eq`/`neq`/comparisons/`in`/`like`/`ilike`), `orderBy`, and `limit`/`offset` — built with the helpers exported from `@super-line/core`:

```ts
import { and, eq, gt, like } from '@super-line/core'

messages.subscribe({
  filter: and(eq('channelId', 'general'), gt('createdAt', since), like('text', '%deploy%')),
})
```

The server **pushes down** what it can and re-checks the exact predicate; the client re-filters too, so an over-approximate result is always safe. `orderBy`/`limit` shape the **initial snapshot**; the live phase then streams every matching change and the consumer owns its window. The full operator set is in the [query IR reference](/reference/) and the same helpers power [TanStack DB queries](/collections/tanstack-db).

::: tip The primitive is non-optimistic
`client.collection(name)` is the raw sync layer: a write appears in `rows()` when the server confirms it. Optimism — instant local application, rollback on error — is [TanStack DB's](/collections/tanstack-db) job, layered on top.
:::

## React

`useCollection` is a thin, typed filtered-list hook for simple cases. For joins and complex live queries, point [TanStack DB](/collections/tanstack-db) at the collection instead:

```tsx
const { rows, insert, update, delete: del } = useCollection('messages', { filter: eq('channelId', id) })
```

::: tip Watch it in the Control Center
Beyond the [Collections schema graph + row browser](/how-to/control-center) — which lists each row's **created** / **updated** timestamps alongside its data — mounting [`inspector()`](/how-to/control-center) streams every subscribe and write to the live feed's **Collections** filter (`collection.sub` / `collection.write` / `collection.change`) — expand a row to see the written data, redacted per your `inspector({ redact })` config. Those created/updated timestamps are inspector-only: they never travel over `client.collection(n).subscribe()`, so `sub.rows()` stays exactly your schema.
:::

## Run it

- [`examples/collections`](https://github.com/mertdogar/super-line/tree/main/examples/collections) — a runnable tsx tracer: RLS pushdown, a `messages ⋈ users` join, and optimistic writes with rollback, in ~120 lines against a real server.
- [`examples/collections-chat`](https://github.com/mertdogar/super-line/tree/main/examples/collections-chat) — a full Slack-like React app: four collections (users/channels/memberships/messages), per-channel row-level security with a join gate, optimistic sends, and the Control Center Collections view.

## Next

- [Row-level security & policies](/collections/policies) — lock down who reads and writes each row.
- [Querying with TanStack DB](/collections/tanstack-db) — joins, live queries, and optimistic mutations.
- [Backends & clustering](/collections/backends) — pick a backend and go multi-node.
