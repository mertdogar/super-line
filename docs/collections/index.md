# Collections

A **collection** is super-line's persisted-state primitive: named, typed state you declare **on the contract**, so the server validates every write and the types flow end-to-end with no codegen. It's the relational successor to the retired last-writer-wins Store family ([ADR-0006](https://github.com/mertdogar/super-line/blob/main/docs/adr/0006-collections-are-on-contract-typed-rows.md), [ADR-0007](https://github.com/mertdogar/super-line/blob/main/docs/adr/0007-crdt-docs-are-typed-collections.md)).

One `collection(n)` concept, **two consistency models**:

<div class="sl-two">

- **[Row collections](/collections/row-collections)** — a table of many small **rows** you filter, subscribe to in subsets, join, and secure per row. Last-writer-wins. Reach for this for messages, users, tasks, orders — anything tabular.
- **[CRDT document collections](/collections/crdt-documents)** — one opaque **document** opened by id, whose concurrent edits **merge** instead of clobbering. Reach for this for a canvas, a rich-text doc, a shared config — one resource edited concurrently.

</div>

Both are declared on the contract and **validated on every write**; they differ only in how concurrent writes resolve.

## The division of labor

super-line does one job here, and does it authoritatively:

- **super-line is the server-authoritative sync source.** It owns the state, validates every write against the contract schema, enforces access control, and streams each caller exactly the subset it's allowed to see — live, across reconnects and across nodes.
- **The client is a query/merge engine on top.** For rows, [TanStack DB](/collections/tanstack-db) runs joins, live queries, and optimistic mutations in the browser over the synced rows. For documents, a CRDT engine merges opaque deltas. super-line ships no query engine of its own — it syncs; the client queries.

That split is the whole idea: row-level security and validation are enforced at the source, where they can't be bypassed, while the rich client work happens where it belongs.

## Declared on the contract

Collections live in `defineContract` alongside your roles, as a top-level `collections` block. A row collection has a `key`; a CRDT document collection has a `crdt` option instead:

```ts
import { defineContract } from '@super-line/core'
import { z } from 'zod'

export const api = defineContract({
  collections: {
    messages: { schema: messageSchema, key: 'id' },                // LWW rows (queryable)
    scenes:   { schema: sceneSchema, crdt: { mode: 'document' } },  // CRDT docs (opened by id)
  },
  roles: { user: { clientToServer: { /* … */ } } },
})
```

Both ends import this one definition, so row and document types flow end-to-end — `RowOf<typeof api, 'messages'>` is the same shape on the server handle, the client handle, and the TanStack collection. **The server validates every write against the schema**, restoring the end-to-end-types-plus-validate-every-message promise for persisted state.

::: tip Which one do I want?
If you'd **query, filter, paginate, join, or secure per row** → [row collection](/collections/row-collections). If **one resource is edited concurrently and must merge** → [CRDT document collection](/collections/crdt-documents). When in doubt, start with rows — they're the common case.
:::

## This section

| Page | What it covers |
| --- | --- |
| [Row collections](/collections/row-collections) | Declare rows, subscribe to live subsets, mutate in atomic batches, the query IR, `useCollection`. |
| [CRDT document collections](/collections/crdt-documents) | Open a doc by id, merge concurrent edits, validate-before-commit, tolerant schemas, `useDoc`. |
| [Row-level security & policies](/collections/policies) | Deny-by-default `read`/`write` policies, the RLS filter, CRDT guards, policy staleness. |
| [Querying with TanStack DB](/collections/tanstack-db) | Joins, live queries, and optimism via the `@super-line/tanstack-db` adapter. |
| [Backends & clustering](/collections/backends) | The capability matrix, `relay` vs. `self` clustering, advisory foreign keys. |

New to collections? The fastest way in is **[Tutorial 2 · Your first collection](/tutorials/first-collection)** — a live, filtered row-set end to end in a few minutes.
