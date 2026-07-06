# ADR-0007: CRDT documents are typed, validated collections; the store family is retired

- Status: Accepted
- Date: 2026-07-06
- Supersedes: [ADR-0003](0003-stores-are-off-contract-and-untyped.md)
- Amends: [ADR-0006](0006-collections-are-on-contract-typed-rows.md) (narrows its "docs are a separate, unvalidatable family" framing)
- Plan: `PLAN-collections-crdt.md` (repo root)

## Context

ADR-0006 introduced collections as the relational successor to the LWW store family, but
explicitly walled off CRDT documents: "collaborative documents are a different animal — opaque
deltas, unvalidatable, unfilterable." That inherited ADR-0003's load-bearing claim that **CRDT
deltas are unvalidatable in principle**, which is why stores were kept off-contract and untyped.

The result was two parallel persisted-state concepts — `collection(n)` (typed rows) and `store(n)`
(untyped docs) — with two families of packages, two access models, and two mental models, for a
solo pre-adoption codebase that wants exactly one.

The premise turns out to be false. The CRDT server engine (`store-sync`) already holds the **live
`StoreValue`** per resource, and super-store exposes `getSnapshot()` → a **plaintext** view of the
merged Yjs document. The server can therefore read the post-merge plaintext of any CRDT doc — which
means it can **validate it against a schema**. "Unvalidatable in principle" was only true under the
assumption that the server treats a doc as pure opaque bytes; the engine never did.

## Decision

Fold CRDT documents **into** collections as a second consistency model, and delete the store family.

- **A CRDT collection is a whole-doc, opened-by-id collection.** Declared on the contract by the
  presence of a `crdt` key (`{ schema, crdt: DocOptions }`, no `key`); `client.collection(n)` and
  `srv.collection(n)` return the reactive-doc handle (the relocated `ResourceReplica` /
  `ServerReplica`) instead of the row-set handle. One accessor, type-discriminated by mode.
- **Every write is validated — including CRDT writes.** The originating node applies an incoming
  delta, snapshots to plaintext, validates against the contract schema, and commits + fans out
  **only if valid**; an invalid write is reverted and never fanned, and the writer is resynced to
  authoritative state. Under relay clustering the gate lives only at ingress; remote nodes trust
  already-validated deltas. The "server validates every inbound write" guarantee now holds
  **uniformly across both consistency models**, with no carve-out.
- **`schema` on a CRDT collection is required** and does double duty: end-to-end types (no codegen)
  and the validation gate. super-store `DocOptions` (recursion mode + opaque paths) move onto the
  contract entry, so both halves derive them from one source — removing `store-sync`'s
  same-resolver-on-both-halves drift footgun.
- **Access is unified as policy callbacks.** CRDT collections use `read(principal, id, snapshot?)`
  and `write(principal, id)` guards under the same `policies` block as LWW collections, deny-by-
  default. The stored per-resource `accessRules` ACL, `setAccess`, and `searchPrincipals` are
  retired; dynamic per-doc sharing becomes a `shares` collection consulted in the callback.
- **Creation stays server-authoritative** (`srv.collection(n).create(id, data)`); clients open
  existing docs, and client-initiated creation routes through a request handler. So the CRDT write
  guard never sees a `create` op.
- **Two backend interfaces, routed by mode.** `CollectionStore` (LWW rows, atomic batches, IR
  queries) is unchanged; CRDT collections are served by the relocated `ServerStore` engine plus a
  validate hook. A CRDT write never participates in a cross-collection atomic batch, so the
  single-backend rule (ADR-0006 dec 13) narrows to single-backend-per-family.
- **All three CRDT durability tiers survive** as relocated packages: `store-sync` →
  `collections-crdt-memory`, `store-sync-libsql` → `collections-crdt-libsql`, `store-sync-pglite`
  → `collections-crdt-pglite`. `store-{memory,sqlite,pglite}` are deleted; the `store(n)` public
  API is retired (`ServerStore`/`ClientStore` survive internally as the CRDT-collection seam).

## Consequences

- **One persisted-state concept: collections.** Two consistency models (LWW rows, CRDT docs)
  behind one `collection(n)` API, one contract block, one `policies` block. `store(n)` and every
  `store-*` package are gone.
- **ADR-0003 is superseded, not merely narrowed.** Its central claim (CRDT deltas unvalidatable in
  principle) is overturned; its secondary claim (stores configured like adapters ⇒ off-contract)
  no longer distinguishes anything, since collections already configure backends in server options.
- **The typed-contract spine now covers CRDT documents.** A buggy or malicious client can no longer
  merge a schema-invalid document; the validation gate rejects it and resyncs the writer.
- **Enforcement carries real, accepted costs.** Per-write server validation; a rejected write forces
  a full-state client resync (optimistic CRDT edits can't be cleanly rolled back); and because
  validation is against the *post-merge* state, concurrent individually-valid deltas can collide on
  aggregate/cross-field constraints and reject the second writer. Guidance: keep CRDT schemas to
  per-field/structural validation and put aggregate invariants in request handlers.
- **Two access models still coexist** — RLS predicate filters for LWW rows, boolean guards for CRDT
  docs — because they subscribe differently (subset-query vs open-by-id). They are unified in config
  shape (`policies`), not in return type.
- **CRDT remains open-by-id, not queryable.** Only *filterability/subset subscription* stays
  LWW-exclusive; metadata-slicing of CRDT docs is via id-encoding + `list()`. TanStack DB serves
  LWW collections only.
- **Package count lands at six backends** (3 LWW + 3 CRDT). The cost of keeping every durability
  tier without regression; accepted over co-location because the durable tier mixes SQLite bindings
  (`better-sqlite3` for LWW, `libsql` for CRDT).
