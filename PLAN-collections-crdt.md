# PLAN — CRDT documents fold into collections (the store family is retired)

Bring the CRDT doc-store family **inside** the collections wall: contract-declared, schema-typed
CRDT documents opened by id, with **enforced server-side validation** of every write, unified
policy-callback access control, and the same `collection(n)` API as typed rows. When this lands
there is exactly one persisted-state concept — **collections** — with two consistency models
(LWW rows, CRDT docs) behind it. Every `store-*` package and the `store(n)` API are deleted.

Decided in a `/grill-me` session on 2026-07-06. Backward compatibility was explicitly out of
scope (solo user, pre-adoption). Companion ADR: `docs/adr/0007-crdt-docs-are-typed-collections.md`
(supersedes ADR-0003, narrows ADR-0006).

## Status

- **Phase 1 (tracer bullet) — BUILT & GREEN (2026-07-06), not committed.** Core CRDT contract types
  (`crdt`-key discrimination, `DocOf`, `isCrdtCollection`); `CrdtCollectionStore` seam +
  validate-before-commit hook; `@super-line/collections-crdt-memory` (server backend +
  `crdtCollectionsClient` universal client); server routing by mode (`cd*` wire frames, ingress
  validation, guard-shaped policies, server-authoritative create, relay fan-out); client
  `collection(n).open(id)` doc handle; react `useDoc`; `ai-canvas` migrated off `store-sync`.
  Proof: `packages/server/test/collections-crdt.integration.test.ts` (6/6) + backend unit tests
  (5/5). Typecheck + oxlint clean. Committed on branch `collections-crdt` (66f02b4).
- **Phase 1.5 (reject→resync) — BUILT & GREEN (2026-07-06).** On a rejected write (validate-before-commit
  or a write-policy denial) the client now **resyncs**: `sendDocWrite`'s reject handler re-opens the doc
  (reusing the `cdopen` catch-up path — no new frame, no server change) and hard-**resets** the replica to
  authoritative state, discarding the optimistic edit. `ResourceReplica.reset?()` is optional (the store
  family never validates/rejects); `CrdtDocReplica.reset` diff-patches back to authoritative plaintext IN
  PLACE via super-store `set` (subscriptions survive). Proof: the writer's own replica now returns to
  authoritative in the validate-before-commit test (extended). Typecheck + oxlint + suite green.
- **Phases 2–4 — not started.**

## The reframe that makes this possible

ADR-0003 kept CRDT stores off-contract because **"CRDT deltas are unvalidatable in principle"**,
and ADR-0006 repeated it ("docs are a different animal — opaque deltas, unvalidatable,
unfilterable"). That claim is only true if the server treats a doc as pure opaque bytes. But the
memory engine already holds the **live `StoreValue`** per resource (`store-sync/src/index.ts:99`),
and super-store exposes `getSnapshot()` → a **plaintext** plain-object view of the Yjs doc. So the
server *can* read the post-merge plaintext, which means it *can* validate it against a schema.

That single fact collapses the wall: a CRDT document can be a typed, on-contract, server-validated
collection. This plan is therefore **not additive** — it overturns ADR-0003's central premise.

## The decision tree (dependency order)

| # | Fork | Decision |
|---|------|----------|
| 1 | What is a CRDT collection structurally? | **Whole-doc CRDT, opened by id.** No querying across docs; `store-sync` under the collection API. |
| 2 | Does it carry a schema? | **Yes, required** — types the doc end-to-end *and* is the validation gate. `crdt`-key presence discriminates; no `key` field (id is external). |
| 3 | Is the schema enforced or advisory? | **Enforced.** Validate-before-commit at the originating node; relay nodes trust already-validated deltas. Uniform "every write validated", no carve-out. |
| 4 | Client/server surface | **One `collection(n)` accessor, type-discriminated by mode.** CRDT handle = the relocated `ResourceReplica`/`ServerReplica`. `list()` kept for **id-enumeration only**. |
| 5 | Backend seam | **Two interfaces routed by mode.** CRDT never joins a cross-collection atomic batch (structurally can't), so the single-backend rule doesn't bind it. |
| 6 | Durability tiers | **Keep all three** by relocating the existing engines (memory / durable / self). No capability regression. |
| 7 | Access control | **Unified policy callbacks, no stored ACL.** `read(principal,id,snapshot?)→bool`, `write(principal,id)→bool`. Deny-by-default. |
| 8 | Contract declaration | **`crdt` key present ⇒ CRDT collection**, its value carries super-store `DocOptions` (drift-free — one contract, both halves). |
| 9 | Packaging & fate | **6 backend packages**; delete `store-*`; retire `store(n)`; `ServerStore`/`ClientStore` survive **internally** as the CRDT-collection seam. |
| 10 | Creation semantics | **Server-authoritative.** `srv.collection(n).create(id, data)`; clients open existing docs; nonexistent → `NOT_FOUND`; client create routes through a request handler. |
| 11 | Control Center / inspector | **Full parity in scope.** Doc-browser folds into the Collections view; ACL browser → policies-as-code; inspector store methods fold in. |

## Topology

```
  contract (single source of truth)
    collections: {
      messages: { schema, key: 'id' },                 // LWW row collection
      scenes:   { schema, crdt: { mode, opaque } },     // CRDT doc collection
    }
         │                                        │
         ▼  server                                ▼  client
  ┌───────────────────────────────┐      ┌───────────────────────────────┐
  │ createSuperLineServer          │      │ client.collection('scenes')     │
  │  collections: [lww, crdt]      │◀────▶│   .open(id) → reactive doc      │──▶ getSnapshot()
  │   (backend per family used)    │ wire │   set/update/delete(path)       │    subscribe()
  │  policies: read/write guards   │      │ client.collection('messages')   │
  │                                │      │   .subscribe(query) → row-set   │──▶ TanStack DB
  │ core routes collection(n) by   │      └───────────────────────────────┘    (LWW only)
  │ declared mode:                 │
  │  LWW  → CollectionStore (batch)│
  │  CRDT → ServerStore (delta)    │  ← relocated engine + validate-before-commit hook
  └───────────────────────────────┘
        │ relay: delta fans over adapter (memory/libsql)
        │ self : Electric is the bus, no adapter (pglite)
        ▼
   other nodes
```

## Contract surface

```ts
const contract = defineContract({
  collections: {
    messages: { schema: msgSchema, key: 'id' },                         // LWW row (unchanged)
    scenes:   { schema: sceneSchema, crdt: { mode: 'document', opaque: ['blob'] } }, // CRDT doc
  },
  clientToServer: { /* unchanged */ },
  serverToClient: { /* unchanged */ },
})
```

- **`crdt` key present ⇒ CRDT collection.** Its value carries super-store `DocOptions`
  (`mode: 'shallow' | 'document'`, `opaque: string[]`) that today live in a standalone resolver —
  moving them onto the contract makes both halves derive them from one source, **eliminating the
  "supply the SAME resolver to both halves" drift footgun** `store-sync` warns about.
- **No `key`** for a CRDT collection: the doc id is external (passed to `open(id)`), not extracted
  from the doc body.
- **`schema` required** — it is both the end-to-end type source (`open(id)` returns
  `StoreValue<Scene>`, `getSnapshot(): Scene`) and the ingress validation gate.
- Naming note: `crdt.mode` is super-store's recursion depth (shallow/document); the LWW-vs-CRDT
  family split is expressed by the `crdt` key's *presence*, so there is no "mode" collision.

## Validation — validate-before-commit (the Q3 mechanism)

The only way to enforce a schema on a merging doc without corrupting canonical state:

1. A client delta arrives at its originating node.
2. The node applies it to the canonical doc, snapshots to plaintext, validates against the schema.
3. **Valid** → commit + fan out. Under relay, remote nodes trust the relayed (already-validated)
   delta and apply blindly — one gate at ingress, cluster-wide guarantee.
4. **Invalid** → revert (clone-and-discard, or an UndoManager revert; single-threaded JS means
   nothing interleaves) and **do not fan out**. The writer is told to **resync**: the server sends
   authoritative full state; the client resets its replica to it. The bad optimistic edit vanishes.

Accepted costs (banked in the grill):
- **Per-write validation cost.** Every delta ⇒ apply + snapshot + schema-parse on the server. Fine
  for typical edit rates; optimizable later by validating only the changed subtree. Not for v1.
- **Reject ⇒ forced client resync.** CRDT clients apply optimistically (local-first is the point),
  so a rejected write can't be cleanly rolled back — full-state resync is the correct repair. Rare
  in practice (the typed handle prevents most).
- **Concurrency/aggregate caveat.** Validation runs against the *post-merge* state, so two
  individually-valid concurrent deltas can merge into a schema-invalid state and the second writer
  is rejected through no fault of its own. This only bites **aggregate/cross-field constraints**
  (`maxItems`, sum-of-fields), never per-field type/presence. **Doc guidance:** keep CRDT schemas
  to per-field/structural validation; put aggregate invariants in request handlers.

## Access control — unified policy callbacks (no stored ACL)

```ts
createSuperLineServer(contract, {
  collections: [lwwBackend, crdtBackend],     // one backend per family used
  policies: {
    scenes: {
      read:  (principal, id, snapshot) => snapshot?.ownerId === principal || shares.has(id, principal),
      write: (principal, id)           => shares.canWrite(id, principal),
    },
  },
})
```

- **Deny-by-default** (no policy ⇒ server-only), same rule as LWW collections.
- **Read guard gets the snapshot on `open`** (content-based auth like RLS reading a row field). On
  `list()` the guard is applied per candidate id (cold-path; write an id-based guard to keep it
  cheap — fits the id-encoded-metadata model).
- **`write` has no `create` op** — creation is server-authoritative (decision 10), so the guard is
  `write(principal, id) → bool` for mutations to existing docs only.
- **`setAccess` / stored reverse-ACL index / `searchPrincipals` retire.** Dynamic per-doc sharing
  ("share this scene with Bob") = a `shares` LWW collection consulted inside the callback.
- Consequence accepted: **two access models coexist** — RLS predicate policies for LWW rows,
  guard callbacks for CRDT docs — unified in *config shape* (`policies` block) though not in return
  type. They subscribe differently (subset-query vs open-by-id), so they authorize differently.

## Backend seam — two interfaces, routed by mode

- `CollectionStore` (LWW rows, atomic batches, IR queries) is **unchanged**.
- CRDT collections are served by the **relocated `ServerStore` engine** + a `validate` hook on its
  `apply` path. It already exists and works; this is re-surfacing `store(n)` as `collection(n)`,
  **not** a rewrite. Forcing deltas through `apply(ops: ResolvedRowOp[])` was rejected as a
  band-aid.
- The server holds one backend **per family the contract uses** and routes each `collection(n)`
  call by declared mode. The "single backend serves all collections" rule (ADR-0006 dec 13)
  narrows to "single backend **per family**" — CRDT gets its own because it never atomic-batches.
- **No cross-family atomic batch.** You cannot atomically "create scene doc *and* insert an index
  row"; sequence it in a request handler if needed.

## Wire

CRDT collections reuse the existing store-frame *logic*, renamed under the collection family:
- **open-or-catch-up** carries full Yjs state on `open` (`sopen`-equivalent).
- **change** carries an opaque base64 delta (`sch`-equivalent), fanned by relay or Electric.
- **delete** fans cluster-wide (`sdel`-equivalent); client handle exposes `deleted`.
- **Reconnect** = re-`open` → fresh full Yjs state (inherited, unchanged).

LWW collections keep `csub`/`cuns`/`cbat`/`cchg`. **TanStack DB serves LWW collections only** —
requesting a CRDT collection through the adapter is an error (open-by-id docs aren't queryable).
**References:** an LWW row may reference a CRDT collection (advisory existence check via `read(id)`);
CRDT collections declare no `references`.

## Packaging & fate

**Keep (LWW):** `collections-memory`, `collections-sqlite`, `collections-pglite`, `tanstack-db`.

**Relocate the CRDT engines (near-1:1 renames) → new packages:**
| from | to | tier |
|------|----|------|
| `store-sync` | `collections-crdt-memory` | memory · relay |
| `store-sync-libsql` | `collections-crdt-libsql` | durable · relay |
| `store-sync-pglite` | `collections-crdt-pglite` | self |

Factories: `crdtMemoryCollections()` / `crdtLibsqlCollections()` / `crdtPgliteCollections()`.
`super-store` stays a dependency of the CRDT packages only.

**Delete:** `store-memory`, `store-sqlite`, `store-pglite`.
**Retire the public API:** `client.store(n)` / `srv.store(n)` / `store(ns)`. `ServerStore` /
`ClientStore` / `ResourceReplica` interfaces survive in core as the internal CRDT-collection seam.

End state: **zero `store-*` packages, zero `store(n)` API — everything is `collection(n)`**, six
backend packages (3 LWW + 3 CRDT via the `-crdt-` infix).

## Phases

1. **Tracer bullet (memory):** contract `crdt` declaration · discriminated `collection(n)` ·
   relocate `store-sync` → `collections-crdt-memory` · validate-before-commit · policy guards ·
   server-authoritative create · wire frames. Migrate **`ai-canvas`** as the end-to-end proof.
2. **Durable + self:** relocate `store-sync-libsql` → `collections-crdt-libsql`,
   `store-sync-pglite` → `collections-crdt-pglite`. Migrate **`ai-canvas-pglite`**.
3. **Sunset + operator view:** delete `store-{memory,sqlite,pglite}` · retire `store(n)` · **full
   Control Center parity** (doc-browser in the Collections view, policies-as-code) + inspector
   fold. Migrate LWW-store examples (**`advanced-chat-app`, `chat-moderation`, `store`,
   `store-pglite`** → `collections-*`) and **`store-sync-json`** → CRDT collection.
4. **Docs:** ADR-0007 · guide (rows vs docs, both under collections) · positioning · skill · delete
   the store guide.

## Deliberately open (implementation-time, not design forks)

- Final wire-frame names and the `collections: [...]`-vs-two-keys config syntax for naming a
  backend per family.
- Revert mechanism for a rejected delta (clone-and-discard vs UndoManager) — both work; pick on
  perf.
- Snapshot-subtree validation optimization (validate only changed paths) — post-v1.
- Whether `synced-canvas-yjs` / `synced-canvas-automerge` (standalone super-store demos, not
  super-line store consumers) are touched at all.

## Reversed / narrowed decisions

- **ADR-0003 (stores off-contract, untyped): superseded.** Its "CRDT deltas are unvalidatable in
  principle" premise is overturned by validate-before-commit; its "configured like adapters"
  premise is moot (collections already configure backends in server options).
- **ADR-0006 (collections are typed rows): amended.** Its "docs are a different animal —
  unvalidatable, unfilterable, kept as separate `store-*`" framing is narrowed: docs are now typed,
  validated collections too; only *filterability* remains LWW-exclusive (CRDT stays open-by-id).
