# ADR-0006: Collections are on-contract typed rows; TanStack DB is the client query engine

- Status: Accepted
- Date: 2026-07-05
- Narrows: [ADR-0003](0003-stores-are-off-contract-and-untyped.md) (which remained in force for CRDT doc stores until ADR-0007 superseded it)
- Amended by: [ADR-0007](0007-crdt-docs-are-typed-collections.md) (folds CRDT docs into collections; retires the store family), [ADR-0009](0009-collection-store-is-discriminated-on-clustering.md) (splits `CollectionStore` into a discriminated union on `clustering`)
- Plan: `PLAN-collections.md` (repo root)

## Context

Real applications outgrow "one JSON document per resource id": they want multiple tables,
foreign-key-shaped references, and joins. Users fake this today by stuffing arrays into a single
LWW resource — losing row-level sync granularity, row-level access control, and any ability to
sync a subset.

Meanwhile the client-side ecosystem converged on a clean seam: **TanStack DB** provides typed
client collections with differential-dataflow live queries (joins, aggregates, sub-ms incremental
updates) and optimistic transactions — and deliberately does **not** prescribe a sync engine.
Since 0.5, *query-driven sync* pushes each live query's `where/orderBy/limit` down to the
collection's sync source, which may legally return a superset (the client re-filters). A
server-authoritative realtime bus that can serve predicate subsets is exactly the missing half.

ADR-0003 kept stores off-contract for two reasons: stores are configured like adapters, and CRDT
deltas are unvalidatable *in principle*. Its consequences explicitly left the door open: "a typed
store option is not foreclosed for LWW stores (where `update` *is* the value and so *is*
validatable)". Collections walk through that door.

## Decision

Introduce **collections** — the relational successor to the LWW store family:

- **super-line is the sync source; TanStack DB is the query engine.** We ship
  `@super-line/tanstack-db` (adapter) and build no query engine of our own — no client-side
  differential dataflow, no Zero-style server-evaluated queries.
- **Collection = namespace, row = resource** (row primary key = resource id). Evolution of the
  existing model, not a parallel subsystem.
- **Schemas live on the contract**: a `collections` block in `defineContract` using the same
  Standard Schema machinery as messages. The server validates every row write — end-to-end
  types and "validate every inbound message" are restored for row data.
- **Subset subscriptions with full expression pushdown**, carried in a small versioned
  expression IR owned by core (and/or/not, comparisons, in, like, dot-path fields, orderBy /
  limit / offset). One shared JS evaluator in core does change routing and scan fallback on
  every backend; SQL backends compile IR → SQL only as a snapshot optimization.
- **Writes are atomic batches** of insert/update/delete ops (schema-validated, policy-guarded),
  mapping 1:1 to a TanStack transaction. Contract requests remain the escape hatch for
  business-logic mutations.
- **Row security is RLS-style**: per-collection server-side policies — `read(principal, ctx)`
  returns an IR filter ANDed into every snapshot/subscription/route; `write(principal, op,
  next, prev)` guards each op. No per-row ACL storage.
- **Relations are metadata + opt-in advisory checks** (`references` in the contract feeds the
  Control Center schema graph and adapter join hints). No cascades in core — cluster-wide FK
  enforcement is unsound under masterless relay clustering; `self` backends may layer real DB
  FKs later.
- **orderBy/limit are snapshot-only; the client owns the window** and backfills on underfill.
  Reconnect is re-snapshot + client-side diff. The server holds no per-subscription state
  beyond the predicate.
- **One backend serves all of a server's collections** (single transaction domain — what makes
  batch atomicity real): `collections-memory` / `collections-sqlite` (relay) and
  `collections-pglite` (self). The LWW `store-*` packages are deprecated in place; open-by-id
  doc DX survives as sugar over `subscribe(pk == id)`.

## Consequences

- **Two families, clean terminology: rows = collections (on-contract, typed), docs = stores
  (CRDT, off-contract).** ADR-0003 is not overturned — it is narrowed to the family whose
  payloads are unvalidatable by construction.
- **Backward compatibility is intentionally broken** for the LWW store family (accepted upfront
  in the grilling): `store-memory` / `store-sqlite` / `store-pglite` are succeeded by
  `collections-*` packages.
- **The typed-contract spine now covers row data.** A buggy or malicious client can no longer
  write malformed rows; hard business gates still belong in typed requests (unchanged guidance).
- **We take a dependency on the TanStack DB ecosystem — but only in one adapter package.** The
  wire speaks our own IR, and the native client primitive (live row-set + batch mutations) keeps
  plain-node, CLI, and non-React consumers first-class. If TanStack DB moves, the blast radius
  is the adapter.
- **Server-side machinery stays deliberately stateless per subscription** (predicate + policy
  filter only). We opted out of Zero-tier server query invalidation and server-maintained
  windows; the documented costs are superset streaming for out-of-window rows and
  reconnect bandwidth proportional to subset size.
- **RLS staleness caveat**: principal-side state captured at subscribe time (e.g. the caller's
  channel list) goes stale until resubscribe; row-side predicates re-evaluate naturally. Needs
  documentation and a server-triggered resubscribe hook.
- **Relay clustering keeps its honesty**: advisory FK checks and per-node atomic batch
  application are best-effort global guarantees; applications needing strict integrity choose a
  `self` backend or route writes through a request handler.
