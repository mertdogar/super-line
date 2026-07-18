# Row-level security & policies

Access control for collections is **server-side and deny-by-default**. A collection with no policy can't be touched by clients at all. This is the server-authoritative half a client query engine can't do on its own — enforced at the sync source, where it can't be bypassed.

Row collections and CRDT documents use **different-shaped** policies, because they're secured differently: rows by a filter + per-op guard, documents by a per-doc guard.

## Row policies

Each row collection gets a `read` and a `write` policy. Omit either and that capability is **denied** to clients:

```ts
import { isIn } from '@super-line/core'

policies: {
  users: { read: () => undefined, write: () => true }, // world-readable directory
  messages: {
    // `read` returns a filter ANDed into every snapshot AND every live change for this caller:
    read: (principal, ctx) => isIn('channelId', ctx.channels), // you only ever see your channels
    // `write` guards each row op — `ctx` carries the same principal-side state as `read`, so a
    // membership check here can't be spoofed by a client claiming a `channelId` it isn't in:
    write: (principal, op, next, prev, ctx) =>
      op === 'delete'
        ? prev?.authorId === principal
        : next?.authorId === principal && ctx.channels.includes(next.channelId), // author-only, and only in channels you're in
  },
}
```

### `read` — a filter, not a boolean

`read` returns a **query-IR filter** (the same [IR](/collections/row-collections#the-query-ir) clients build) that is ANDed into every snapshot and every live change delivered to that caller. Return `undefined` to allow the whole collection; return a filter to scope it. Routing is stateless per connection beyond this predicate: a change is delivered if the pre-op **or** post-op row matches, and the client re-filters — so an over-approximate match is always safe.

### `write` — a per-op guard

`write(principal, op, next, prev, ctx)` returns a boolean for each `insert`/`update`/`delete`. `next` is the incoming row (absent on delete), `prev` the existing one (absent on insert), and `ctx` is the same per-connection context `read` sees — enough to enforce author-only edits, immutable fields, ownership transfer rules, or (as above) a membership check against principal-side state.

::: warning Policy staleness
`read` is evaluated **at subscribe time**. Principal-side state captured there (e.g. the caller's channel list) goes stale until the client resubscribes; row-side predicates (`channelId in …`) re-evaluate on every change naturally. If a caller's visibility changes, have them resubscribe.
:::

### Server co-writes bypass policy

Server code writing through `srv.collection(n)` bypasses `read`/`write` (it's trusted) but is **still schema-validated**. That's the door for business-logic mutations a request handler owns — a moderator delete, a system message — without granting the client that power.

## CRDT document guards

A [CRDT document collection](/collections/crdt-documents) is **opened by id, not queried**, so its policy is a plain guard, not a filter — deny-by-default like rows:

```ts
policies: {
  scenes: {
    read:  (principal, id, snapshot, ctx) => snapshot?.ownerId === principal, // may inspect the snapshot
    write: (principal, id, ctx) => true,
  },
}
```

`read(principal, id, snapshot, ctx)` decides whether the caller may open the document (and may inspect the current snapshot to decide); `write(principal, id, ctx)` decides whether they may write to it. There's no per-row filter because a document is opened whole. Creation is [server-authoritative](/collections/crdt-documents#server-a-backend-a-guard-and-create-the-doc) — clients only open.

## Advisory foreign keys

`references` on a contract collection is metadata that feeds the Control Center schema graph and the [TanStack adapter's](/collections/tanstack-db) join hints. Turn on an opt-in existence check with `checkReferences: true` on the server — an insert/update whose reference points at a missing row is then rejected.

It's **advisory**: best-effort under `relay` clustering (no global serialization point), with no cascades, and it doesn't resolve intra-batch parent-then-child references. For strict integrity, use a [`self` backend](/collections/backends) or route the write through a request handler. See [Backends & clustering](/collections/backends#advisory-foreign-keys) for the trade-offs.

## Next

- [Row collections](/collections/row-collections) — the write and subscribe API these policies guard.
- [Backends & clustering](/collections/backends) — how routing and integrity behave per backend tier.
