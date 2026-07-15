# ADR-0009: CollectionStore is discriminated on `clustering`; the relay-sync invariant is a type

- Status: Accepted
- Date: 2026-07-15
- Amends: [ADR-0006](0006-collections-are-on-contract-typed-rows.md) (narrows the `CollectionStore` seam it introduced)
- Investigation: two sessions of `/improve-codebase-architecture` → `/grilling`, plus the conformance suite in `core/test/collection-store-conformance.ts`

## Context

`CollectionStore` declared `clustering: 'relay' | 'self'` as if it only told core **how to route around**
the backend — relay batches over the Adapter, or leave it to the backend's own replication. It does more
than that. The mode changes `apply`'s contract, in three ways, and the type said none of them:

|                          | `relay` (memory, sqlite)        | `self` (pglite)                        |
| ------------------------ | ------------------------------- | -------------------------------------- |
| `apply` must be sync?    | **yes** — or the cluster storms | no; nothing relays it                  |
| `apply` fires `onChange`?| yes, before returning           | **no** — its replication feed does     |
| `apply` returns changes? | yes                             | **no** — nothing                       |

The synchrony rule is the dangerous one. The relay ingress fires-and-forgets (`void apply(...)`) so a
cross-node race lands in a `try`/`catch`, and the CRDT sibling clears a re-publish guard in `finally`. An
async `apply` escapes that catch and clears that guard *before the change is ever emitted* — so a node
re-publishes a delta it merely relayed in, forever. One relayed write becomes a cluster-wide echo storm.
`origin` cannot substitute for the guard: it names the **writer** and survives the relay, so a receiving
node cannot tell a relayed delta from a local write by that same writer.

That rule was real, load-bearing, and recorded **only in `collections-crdt-libsql`'s private doc comment** —
that backend rebuilt its persistence strategy around it (sync hot path, debounced `onChange` writer) and
wrote down why, in a file no other implementer reads. Meanwhile `collections-pglite` openly contradicted
core's prose in a comment of its own (*"the return value is intentionally empty"*), and core's prose said
`apply` "fires onChange once per resulting change, and returns those changes" — false for one of three
first-party backends.

We patched this twice before reaching for the type system. First as **prose** (per-mode wording on `apply`).
Then as a **runtime gate** in the shared conformance suite. Both are downstream of the same cause: one type
claiming one contract where there are two. And neither protects anyone outside this repo — the conformance
suite is deliberately unpublished, so **the type is the only thing that ships**.

## Decision

`CollectionStore` becomes a discriminated union on `clustering`:

```ts
export interface RelayCollectionStore extends CollectionStoreBase {
  readonly clustering: 'relay'
  apply(ops: ResolvedRowOp[], origin: string): RowChange[]
}
export interface SelfCollectionStore extends CollectionStoreBase {
  readonly clustering: 'self'
  apply(ops: ResolvedRowOp[], origin: string): Awaitable<void>
}
export type CollectionStore = RelayCollectionStore | SelfCollectionStore
```

**`RelayCollectionStore.apply`'s non-void return type is load-bearing.** It is the sole mechanism making an
async relay backend a compile error, because an `async` method cannot satisfy a `RowChange[]` return. The
return value itself is unused by every call site — that is fine; **its consumer is the type checker**. It
must not be "cleaned up" to `void`: TypeScript's void-return rule accepts a function returning *anything*
where `void` is declared, so `apply(): void` would silently permit `async apply()` again and the invariant
would evaporate with no diagnostic. `core/test/collections.test.ts` pins both halves — a `@ts-expect-error`
proving the async relay backend is rejected, and an un-suppressed test demonstrating that the `void`
formulation would *not* have been.

## Consequences

- **The invariant is enforced where it travels.** A third-party backend author gets a compile error rather
  than a production echo storm, without importing anything.
- **`self`'s `apply` stops lying.** `collections-pglite` dropped its dead `return []`; the type now says what
  its comment already admitted.
- **Read-only consumers are unaffected.** `plugin-auth` calls only `.read()`, identical in both modes, so it
  uses the union with no narrowing. The server needs none either: `await store.apply(...)` typechecks against
  a union of call signatures whose parameters match, and all three call sites discard the result.
- **One difference stays untyped.** *Who fires `onChange`* has an identical signature in both modes, so it
  remains prose plus the conformance gate. Two of three is the honest ceiling here.
- **Breaking**, at the type level, for anyone implementing `CollectionStore`. Every implementer today is
  first-party (memory, sqlite, pglite), each now annotated with its specific member.

## Rejected alternatives

- **Leave it as prose + the conformance gate.** Status quo after two patches. Rejected: the suite is
  unpublished, so it protects only this repo, and the failure it guards is a cluster-wide echo storm.
- **`apply(): void` on both modes.** Tempting — an architecture review had flagged the return as dead code.
  Rejected on evidence: `void` does not forbid async (verified), so this makes the breaking change and keeps
  the band-aid. The "dead" return is the enforcement.
- **Split `CrdtCollectionStore` the same way.** Its `apply` returns nothing, so enforcing synchrony there
  would mean *inventing* a return value plus a capture hack in the validate-before-commit hot path — the
  emitted `DocChange` is built inside the StoreValue's `onUpdate` hook, not in `apply`. Rejected as machinery
  added to satisfy a type checker. Its invariant is asserted at runtime instead, against both relay backends.
  Revisit if a third-party CRDT backend ever appears.
