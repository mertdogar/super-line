# Querying with TanStack DB

super-line syncs; it does not query. For joins, live queries, and optimistic mutations, hand a [row collection](/collections/row-collections) to [TanStack DB](https://tanstack.com/db) via the first-party [`@super-line/tanstack-db`](https://www.npmjs.com/package/@super-line/tanstack-db) adapter. TanStack DB is the client query engine; super-line is the server-authoritative source under it.

## Wire a collection into TanStack

```ts
import { createCollection, createLiveQueryCollection, eq } from '@tanstack/db'
import { superLineCollectionOptions } from '@super-line/tanstack-db'

const users = createCollection(superLineCollectionOptions(client, api, 'users'))
const messages = createCollection(
  superLineCollectionOptions(client, api, 'messages', { query: { filter: eq('channelId', 'general') } }),
)
```

`superLineCollectionOptions` derives `getKey` from the contract, subscribes over super-line for the given query, and maps each TanStack transaction to **one atomic super-line batch** — the ack resolves the optimistic commit; an error rolls it back.

## Joins and live queries

```ts
// a client-side join, denormalizing author names onto messages — updates incrementally as rows sync
const feed = createLiveQueryCollection((q) =>
  q.from({ m: messages })
    .join({ u: users }, ({ m, u }) => eq(u.id, m.authorId), 'inner')
    .select(({ m, u }) => ({ id: m.id, text: m.text, author: u.name })),
)
```

Joins, ordering, and incremental recomputation all run **in the browser** over the synced rows — TanStack's query predicates are never pushed to the server. What crosses the wire is set per collection by the `query:` [IR](/collections/row-collections#the-query-ir) filter you hand to `superLineCollectionOptions` (above, `messages` is narrowed to one channel; `users` syncs whole).

## React

Use `useLiveQuery` from `@tanstack/react-db` with the same query builder:

```tsx
import { useLiveQuery } from '@tanstack/react-db'

const { data } = useLiveQuery((q) =>
  q.from({ m: messages }).join({ u: users }, ({ m, u }) => eq(u.id, m.authorId), 'inner'),
)
```

## Optimism

TanStack DB applies mutations **optimistically** — locally, instantly — then reconciles against the server ack. On error it rolls back. That's the layer [`client.collection(n)`](/collections/row-collections#the-primitive-is-non-optimistic) deliberately doesn't provide: the raw sync layer is non-optimistic (a write appears when the server confirms it), and TanStack adds optimism on top.

## When you don't need TanStack

For a simple filtered list, [`useCollection`](/collections/row-collections#react) or a raw `client.collection(n).subscribe(query)` is enough — no query engine required. Reach for TanStack DB when you need **joins, multi-collection live queries, or optimistic UX**.

## Run it

[`examples/collections`](https://github.com/mertdogar/super-line/tree/main/examples/collections) shows a `messages ⋈ users` join and optimistic writes with rollback against a real server, and [`examples/collections-chat`](https://github.com/mertdogar/super-line/tree/main/examples/collections-chat) is a full Slack-like app built on the adapter.
