# ADR snapshot — the consolidated position

Where the 19 ADRs *net out* as of **2026-07-24**. The individual files are the reasoning
and the rejected alternatives; this is the standing answer plus the supersession graph, so
nobody re-derives a path that was already walked and closed.

Repo-internal: `docs/.vitepress/config.ts` excludes `adr/**` from the docs site, and
`skills/super-line/` must never cite an ADR — state the behavior there instead.

## 1. Ledger

| ADR | Decision | Status today |
| --- | --- | --- |
| 0001 | Automerge (3.x) as the CRDT | **Superseded** by 0002 |
| 0002 | Yjs, via `super-store`, as the CRDT engine | In force (vocabulary note added — the seam is now `CrdtCollectionStore`) |
| 0003 | Stores are off-contract and untyped | **Superseded** by 0007 (narrowed first by 0006) |
| 0004 | Composition, not connection namespaces; mux transport deferred | In force |
| 0005 | Plugins as paired runtime bundles | In force, amended by 0019 (the contract-time half) |
| 0006 | Collections are on-contract typed rows; TanStack DB is the client query engine | In force, amended by 0007 + 0009 |
| 0007 | CRDT docs are typed collections; the store family is retired | In force, amended by 0008 |
| 0008 | Validate-before-commit is scoped to present values; CRDT schemas must be presence-tolerant | In force |
| 0009 | `CollectionStore` is discriminated on `clustering`; the relay-sync invariant is a type | In force |
| 0010 | A reusable plugin's mutations are requests-first, wrapped in domain hooks | In force |
| 0011 | Streamed messages are parts-rows plus ephemeral deltas | In force (amended in place 2026-07-19) |
| 0012 | `env` — a server-vended, client-visible per-connection state bag | In force |
| 0013 | plugin-chat host schemas bridge through Standard Schema | In force |
| 0014 | A streamed message always settles before it vanishes | In force (reverses a deliberate 0.5.0 choice) |
| 0015 | Bearer assertions come in two kinds — signed and sealed | In force; its **client-minting half was retired** 2026-07-24 |
| 0016 | Merged contracts retain their plugin fragments | In force (amends 0019) |
| 0017 | plugin-auth hooks cover server-invoked operations, not client requests | In force |
| 0018 | Logging is app-configured (LogTape), not a per-instance option | In force |
| 0019 | Plugins grow a contract-time half — typed fragments merged at `defineContract` | In force (recorded retroactively 2026-07-24; decision + code date to 2026-07-06, core 0.10.1) |

## 2. The standing position, by subsystem

**Persisted state is one concept: collections.** Two consistency models behind one
`collection(n)` accessor — LWW rows (`key`, queryable, subset-subscribable) and CRDT docs
(`crdt`, opened by id, whole-doc merge). Both are declared on the contract, both are
schema-validated on write, both are governed by one `policies` block, deny-by-default.
The `store(n)` API and every `store-*` package are deleted. `0006 → 0007`

**The typed-contract spine covers every write, honestly.** Row writes are validated
outright. CRDT writes are validated **before commit at the ingress node** (merge onto a
scratch copy → snapshot to plaintext → validate → commit and fan out only if valid; relay
nodes trust already-validated deltas), but the guarantee is *"every value a write sets has
the right type"* — **not** *"the document is always complete"*. A CRDT overwrite is
internally delete-then-insert, so a concurrently-mutated field can be transiently absent;
hard-requiring it manufactures reject→resync churn, permanent op-log causal gaps, and (once
compaction folds them into a baseline) a permanently wedged collection. Therefore CRDT
schemas **must** be presence-tolerant (`.catch()` / `.optional()`); `required` is reserved
for write-once fields, and aggregate invariants belong in request handlers. This is
load-bearing, not ergonomic: it is the precondition for turning compaction on. `0007 → 0008`

**No query engine of our own.** super-line is the server-authoritative sync source; TanStack
DB is the client query engine, isolated in `@super-line/tanstack-db`. Core owns a versioned
expression IR + one JS evaluator shared by change-routing, snapshots, and client re-filtering;
SQL backends compile IR→SQL only as an optimization. Server state per subscription is the
predicate and the policy filter — nothing more. `orderBy`/`limit` are snapshot-only; the
client owns the window. TanStack DB serves LWW collections only. `0006`

**The backend seam is two interfaces, and the clustering mode is a type.** `CollectionStore`
is a discriminated union: `relay`'s `apply` returns `RowChange[]` — a return value **no call
site uses, whose consumer is the type checker**, because it is the only thing making an
`async` relay backend a compile error and thereby preventing a cluster-wide echo storm. Do
not "clean it up" to `void`; `void` does not forbid `async`. `self`'s `apply` is
`Awaitable<void>` and its replication feed fires `onChange`. CRDT collections use a separate
`CrdtCollectionStore` and never join a cross-collection atomic batch; its synchrony invariant
is asserted at runtime instead. `0006 → 0009`, `0007`

**Extension is composition, not namespaces.** One socket, one session, one identity. An
embedded library exports contract fragments (`defineSurface` preserves the `const` literals
that keep `subscribe: true` from widening to `boolean`); `mergeSurfaces` makes a duplicate key
a compile error naming the key. Namespacing is a key-prefix convention; room names stay
unenforceable. Handler exhaustiveness protects the weave. `0004`

**Plugins are paired bundles that observe and contribute — never intercept.** Registered
`plugins: [...]` on both factories; node-local taps over the InspectorEvent taxonomy,
multiplexed lifecycle hooks, an imperative `setup(ctx)` escape hatch, and compile-time
subtraction of plugin-owned keys from `implement()`. Zero cost when nothing taps. The
inspector is the acceptance test and now ships as `@super-line/plugin-inspector`. The
contract-time half (ADR-0019, recorded retroactively): a plugin also ships a typed
**contract fragment** (`ContractPlugin`), merged by `defineContract({ plugins })` as a plain
type intersection — `RowOf`/per-role `Requests`/`client.collection` infer from the single
materialized contract with zero generic-threading; duplicate keys are startup throws naming
the plugin; policies stay on the runtime half; `SubtractHandlers` drops fully-plugin-owned
handler blocks to optional. The merged contract **retains its `ContractPlugin[]`** rather
than deriving a reverse index, so provenance stays at the source and the inspector does the
projecting. `0005 → 0019 → 0016`

**A reusable domain plugin's mutations are requests, not row-writes.** Its collections are
client-read-only (`read` policies scope visibility; `write` omitted ⇒ denied), making them a
pure sync surface. Every mutation is a contract request handled server-authoritatively,
co-writing through `srv.collection(n)`. One domain core per operation is shared by the wire
handler and the imperative kit, wrapped in `before` (transform or veto) / `after` (observe)
hooks that fire for both — one un-bypassable seam. The price, paid knowingly: **no optimistic
sends**. This scopes only *reusable plugins*; an app's own collections still take direct
optimistic row-writes. `0010`

**plugin-auth splits the hook line by invoker, not by operation.** Hooks cover
`authenticate` and the imperative kit (`users`/`credentials`/`apiKeys`/`tokens`); the client
request handlers are **not** hooked because they already have a veto seam in `use:`
middleware. `authenticate.after` may transform or veto (it commits nothing — it produces
identity); `users.deactivate.before` **cannot** veto (incident response must never be
blockable). Hook payloads carry raw secrets by design. `0010 → 0017`

**Bearer assertions are signed or sealed, and both are server-minted.** JWS carries a public
`claims` bag its holder can read; JWE carries `claims` + a `sealed` bag opaque to its own
holder. Dispatched on compact dot count (2 vs 4), landing on `ctx.claims` / `ctx.sealed`,
with `authMethod` recording provenance. Roles come from the user row for sealed, from the
token for signed. Verification always passes the *configured* algorithms explicitly — never
the token's own header. The public half reaches the client through `env`, not a new
primitive. Client-side minting was retired 2026-07-24, which closes the ADR's own latent
"any client can assert about itself" problem at the root. `0012 → 0015`

**`env` is the client-visible corner of the per-connection grid.** `ctx` = frozen +
server-only (authorization keys on it); `data` = mutable + server-only; `env` = mutable +
client-visible, contract-typed per role, validated on write, seeded by `authenticate`,
updated via `conn.setEnv` / `srv.toUser(id).setEnv`, **never persisted**, masked-by-default in
the Control Center with host-allow-listed `revealEnvKeys`. It is credential *delivery*, not
delegation — super-line is a pure courier. `0012`

**Streaming is durable parts-rows plus ephemeral deltas.** One row per part
(`${messageId}:${idx}`) keeps rewrite cost bounded (a single growing row is O(turn²) on the
wire); the message row is a thin envelope. Deltas broadcast to membership-authorized
per-channel **rooms** — topics are role-wide and lost on privacy. The in-flight part
checkpoints ~1s with an `offset`, so rows alone reconstruct any viewer path and a lost delta
costs ≤1s of smoothness, never correctness. The wire union is deliberately not AI SDK
`UIMessageChunk` — adapters absorb SDK drift at the edge. Lifecycle is disconnect-abort, no
timers. And **a streamed message always settles before it vanishes**: deleting a streaming
row signals the author, force-aborts, *then* deletes — so `status !== 'streaming'` is a
reliable turn boundary. Host `content`/`data` slots accept any Standard Schema (sync
validators only). `0011 → 0013 → 0014`

**Logging is the app's to configure.** Packages only `getLogger(['super-line', pkg,
subsystem])`; they never call `configure()`. LogTape's registry is a single process-global,
and super-line builds many instances per process, so a per-instance `logLevel` is unworkable
— its absence is deliberate. `enableSuperLineLogging()` is app-level sugar over
`configureSync()`, mutually exclusive with a host's own `configure()`. Silent unless
configured. Orthogonal to the inspector: LogTape sees internal diagnostics, taps see wire
traffic, no bridge. `0018`

## 3. Reversals — closed paths, do not re-walk

| Was decided | Now | Why it flipped |
| --- | --- | --- |
| Automerge, accepting the WASM cost (0001) | **Yjs via `super-store`** (0002) | `super-store` *is* the plain-object layer whose absence was Automerge's whole edge — so the ~18 kB pure-JS option now wins on both axes |
| CRDT deltas are unvalidatable **in principle** ⇒ stores off-contract (0003) | **Validated before commit** (0007) | The premise was false: the engine already holds a live `StoreValue` and `getSnapshot()` yields post-merge plaintext |
| Validate the whole post-merge document (0007 as shipped) | **Validate present values only** (0008) | Enforcing completeness rejects legitimate mid-merge states and wedges the collection permanently |
| Chat = optimistic client row-writes (`examples/collections-chat`'s stated philosophy) | **Requests-first + domain hooks** (0010) | Multi-row/cascade ops can't be one write; a per-row boolean `write` policy can't host cross-cutting logic |
| Delete a streaming message ⇒ rows just vanish (0.5.0) | **Settle, then delete** (0014) | No terminal status wedged every consumer folding on "turn finished", and stranded the producer's stream handle |
| Clients may mint JWT assertions (`getToken`) | **Server-minted only** (0015 update, 2026-07-24) | A client-mintable payload the server later reads back is a client asserting about itself |
| One `CollectionStore` interface with prose about modes (0006) | **Discriminated union** (0009) | Prose and an unpublished conformance suite protect only this repo; the failure mode is a cluster-wide echo storm |

**Rejected-and-recorded**, so the same ideas don't come back around: core wire namespaces
(Socket.IO-style `ns` in every frame, 0004) · middleware-everywhere and imperative-only
plugins (0005) · a Zero-style server query engine and server-maintained windows (0006) · a
generic "validate the write, not the document" back-fill — *implemented, measured worse
(352 vs 293 rejects), reverted* (0008) · `apply(): void` on both modes (0009) · clients
minting sealed assertions, sealed tokens carrying roles, identity-free capability tokens,
auto-seeding `env` from claims (0015) · a reverse plugin index in core (0016) · a per-instance
`logLevel` (0018) · generic-threading a plugin's fragment through the server/client factories
("fragile") and hand-declaring a plugin's surface in the host contract ("leaks secrets") (0019).

## 4. Deferred, with revival criteria

- **Mux transport** (`PLAN-transport-mux.md`) — fully designed, revived only if a consumer
  needs two stacks that must *not* share identity/lifecycle. Purely additive; composition
  forecloses nothing. `0004`
- **Ditching CRDT validation entirely** — the honest escape hatch if presence-tolerance proves
  too costly in practice. `0008`
- **`crdtTolerant(schema)`** — an opt-in Zod-specific deep-optionalizer applied at contract
  time (the author *can* introspect; core can't, through Standard Schema). Convenience, not a
  correctness fix. `0008`
- **Splitting `CrdtCollectionStore` on `clustering`** — rejected as machinery-to-satisfy-a-checker;
  revisit if a third-party CRDT backend ever appears. `0009`
- **A `signUp` hook** — `MiddlewareInfo` carries no request body, so a password-policy or
  disposable-email check on the client signup path currently has no home; the workaround is the
  hooked `authKit.credentials.create`. Single additive hook if it's ever wanted. `0017`
- **Intersecting token roles with row roles** — the safe form of scoped tokens, additive. `0015`
- **A server-triggered resubscribe hook** for the RLS staleness caveat (principal-side state
  captured at subscribe time goes stale; row-side predicates re-evaluate naturally). `0006`

## 5. Bookkeeping drift — found 2026-07-24, repaired the same day

Six drift items were found while compiling this snapshot and one more surfaced during the
verification sweep; all were fixed on 2026-07-24 (none changed a decision):

1. **0003's status** now reads Superseded by 0007 (was "Accepted — narrowed by 0006"), with a
   0001-style superseded note.
2. **0006** gained `Amended by: 0007, 0009` back-links.
3. **0016** gained its `ADR-0016:` title prefix and Status/Date front-matter (created
   2026-07-23, per git).
4. **ADR-0019 was written** for `defineContract({ plugins })` — retroactively recording the
   2026-07-06 decision (`PLAN-plugin-auth.md` settled decision 6, commit `df7e72d`, core
   0.10.1) that both first-party plugins and 0016 lean on. 0005 now points at it.
5. **The two dead `docs/guide/synced-state.md` links** (0002, 0003) now name the successor,
   `docs/collections/crdt-documents.md` (deletion traced to the store-family retirement +
   Diátaxis restructure).
6. **0002** gained a vocabulary note: the `Store`/`CrdtStore` seam it names is now
   `CrdtCollectionStore`; the decision (Yjs via `@super-store/store@^0.3.0`, verified across
   all three `collections-crdt-*` packages) stands.
7. **Found in verification: 0007 misquoted 0006.** It attributed a verbatim quote
   ("collaborative documents are a different animal…") to ADR-0006, which never contains it —
   the sentence is from `PLAN-collections.md:216`, and `PLAN-collections-crdt.md` had already
   repeated the misattribution. 0007 now attributes the quote to the plan and quotes 0006's
   actual phrase ("whose payloads are unvalidatable by construction"). The PLAN files keep
   their historical wording.

*Spot-checked against the tree while writing: no `packages/store-*` remain · `RelayCollectionStore` /
`SelfCollectionStore` union at `packages/core/src/collections.ts:83,107,134` · `defineSurface` /
`mergeSurfaces` at `packages/core/src/contract.ts:230,247` · `Conn.setEnv` at
`packages/server/src/conn.ts:25` · contract-plugin merge at `packages/core/src/contract.ts:161-187,273-338`
· policy merge + `SubtractHandlers` at `packages/server/src/index.ts:289-298,613-628`.*
