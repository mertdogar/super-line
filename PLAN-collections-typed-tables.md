# PLAN — Typed per-collection tables (option 2)

Give every LWW collection its **own SQL table with real typed columns** derived from its Zod
schema, replacing the single generic `collection_rows` (collection, id, data JSON) table in
`collections-sqlite` and `collections-pglite`. The backend factories receive the contract's
collection specs, generate DDL at construction, and compile the query IR against real columns —
raising the pushdown ceiling (WHERE + ORDER BY + LIMIT/OFFSET) while the JS evaluator stays the
correctness authority. `collections-memory` and all CRDT backends are untouched.

Decided 2026-07-17 after a multi-agent code analysis (7 readers + completeness critic over the
seam, query IR, server runtime, backends, Electric tier, and a schema census). **Backward
compatibility is explicitly out of scope** (pre-adoption, solo dev): factory signatures break
freely, the generic-table layout is deleted from the SQL backends (not kept as a mode), the
legacy `ALTER TABLE` shims go, and existing dev `.db` files are simply recreated.

## Status

- **Phase 0 (column plan in core) — BUILT & GREEN (2026-07-17), not committed.** `planColumns` +
  `ColumnPlan`/`ColumnSpec`/`ColumnKind`/`DEGENERATE_DATA_COLUMN` in `core/src/column-plan.ts`,
  exported from core. 14 tests over the census shapes (`core/test/column-plan.test.ts`). Fast lane
  65 files / 524 tests, typecheck + oxlint clean. Gotcha: zod 3's refine effect discriminator is
  `'refinement'`, not `'refine'`.
- **Phase 1 (sqlite typed tables) — BUILT & GREEN (2026-07-17), not committed.** `collections-sqlite`
  rewritten: `col_<name>` typed tables + `col_meta` fingerprints (additive auto-ALTER, refusal
  otherwise), factory takes required `collections`, exactness-tracked IR→SQL compiler (two-valued
  `IS`/`COALESCE` forms; exact queries push ORDER BY/LIMIT/OFFSET and skip the JS re-run; text
  range/order never pushed — UTF-8 byte vs UTF-16 code-unit order diverge). Planner amendment:
  optional+nullable scalars demote to `json` kind (SQL NULL can't carry both absent and null).
  Call sites updated (server integration test, collections-chat, chat-supervisor; stale dev .db
  files deleted). 32 backend tests incl. conformance; fast lane 65 files / 528 tests green.
- **Phase 2 (pglite typed tables + real-Electric harness) — BUILT & GREEN (2026-07-17), not committed.**
  2a: first real-Electric integration test for LWW rows (testcontainers Postgres+Electric, 2 nodes,
  heavy lane) pinning whole-row `next`, origin round-trip, prev-less deletes — landed against the old
  backend first, then re-verified against the rewrite. 2b: `collections-pglite` rewritten — per-collection
  typed tables (`tablePrefix`, default `col_`), `<prefix>meta` fingerprints, construction DDL serialized
  behind `pg_advisory_xact_lock` inside one tx (IF-NOT-EXISTS forms replace the swallowed-error taxonomy —
  a poisoned-tx hazard under BEGIN), one Electric shape + one `live.changes` per table (SOH `pk` hack
  deleted), **full-row re-read from the local replica on partial UPDATE diffs**, json columns read
  `::text` everywhere so postgres.js and PGlite decode identically, superset-only Postgres WHERE
  narrowing (fixes the fetch-everything ponytail; JS stays authoritative). pglite unit suite moved to the
  heavy lane (same WASM-CPU starvation as crdt-pglite). Both lanes green (fast 64/510 · integration 31/146).

## What the analysis established (why this is safe)

- **The `CollectionStore` seam does not change.** `snapshot(n, query)` / `read(n, id)` /
  `apply(ops)` traffic in collection-name strings and opaque rows (`core/src/collections.ts`);
  table layout is invisible above the seam. The conformance suite
  (`core/test/collection-store-conformance.ts`) is storage-shape-agnostic and is the acceptance
  bar for both phases.
- **ADR-0006 permits this.** Its invariant is *one backend instance = one transaction domain*
  (batch atomicity), not one physical table. N tables in the same SQLite file under one
  `db.transaction()` — or the same Postgres under one tx — satisfies it exactly.
- **The wiring gap is plumbing, not machinery.** The server already derives full collection defs
  from the contract (`server/src/index.ts:581`) but the store is user-constructed earlier. Fix:
  the factory takes the (post-plugin-merge) `contract.collections` object directly.
- **IR→SQL has a working template.** `compileWhere` in `collections-sqlite` (superset-safe,
  JS-authoritative per `query.ts:8-9`) retargets from `json_extract` to real columns.
- **The evaluator's edge semantics are the contract**: missing ≠ null, no type coercion,
  incomparable → predicate false / sort tied, `like` on non-string → false. Any SQL translation
  either reproduces them exactly or bails to the JS path. The server's live-change routing
  (`server/src/collections/rows.ts:244`) evaluates the same filters in JS forever — divergent
  pushdown would silently split snapshots from live delivery.

## The decision tree (dependency order)

| # | Fork | Decision |
|---|------|----------|
| 1 | Table layout | **One table per LWW collection, named `col_<name>`** (prefix avoids `crdt_docs`/`crdt_docs_updates` collisions in shared Postgres and reserves namespace for meta tables). Collection names validated against the existing `IDENT` pattern. The collection's `key` field is the PRIMARY KEY column. |
| 2 | Column mapping | **Hybrid, per field.** Top-level Zod scalar fields (string/number/boolean, incl. `.optional()`/`.nullable()`/`.default()`/enum) → typed columns (nullable when optional/nullable). Everything else (`z.record`, unions, nested objects, arrays, `z.any`/`z.unknown`) → **its own JSON column** — per-field, not one overflow blob, so dot-path filters (`author.name`) still push down via `json_extract`/`->>` into that column. The recurring `metadata: z.record(...)` idiom lands here by design. Infra columns are prefix-reserved: `_sl_created_at`/`_sl_updated_at` (both dialects), `_sl_origin` (pglite only — Electric strips attribution); `planColumns` rejects schema fields starting with `_sl_`. |
| 3 | Non-Zod schemas | Schema isn't an introspectable `z.ZodObject` (Valibot/ArkType/factory output that isn't Zod) → the table degrades to key column + one `data` JSON column. Still per-collection, still conformant. Keeps the Standard Schema promise; no contract-level type narrowing. |
| 4 | Pushdown authority | **JS `applyQuery` stays authoritative.** The compiler reports *exactness*: if filter AND orderBy compile completely, push ORDER BY + LIMIT/OFFSET and skip the JS re-run; otherwise superset-safe WHERE narrowing + full JS re-apply (today's pattern). Sort tightening (single-typed columns make "incomparable → tied" moot) is accepted; nulls sort last via `ORDER BY col IS NULL, col`. |
| 5 | Missing vs null | A typed column has no `undefined`. On write, an absent optional field is stored as SQL `NULL`; on read-back the row is reconstructed **omitting** `NULL` columns for fields the schema marks optional-but-not-nullable, preserving the evaluator's missing ≠ null distinction round-trip. Fields that are genuinely `.nullable()` read back as `null`. |
| 6 | Migrations | **Fingerprint + additive-only auto.** A `col_meta` table stores each collection's column-plan fingerprint. On boot: match → proceed; additive diff (new nullable/defaulted columns) → auto `ALTER TABLE ADD COLUMN`; anything else → **refuse to boot** with a clear error naming the collection and the diff (dev answer: delete the db file). No versioned-migration framework. Rolling deploys fall out for free: additive → mixed-version nodes coexist (old nodes' statements leave new columns NULL/default); destructive → the new node refuses boot while the running cluster is untouched. |
| 7 | `references` | **Stay advisory.** No real SQL FK constraints — they'd change failure semantics (DB constraint error vs the opt-in `checkReferences` VALIDATION error) and imply cascade policy we don't have. |
| 8 | CRDT collections | **Excluded.** No `key`, opened-not-queried, worst-case schemas (`z.record(z.string(), z.any())`), zero code shared with LWW backends (verified). CRDT stores keep their own tables. |
| 9 | Factory API | `sqliteCollections({ file, collections })` / `pgliteCollections({ pgUrl, electricUrl?, collections })` — **`collections` (the contract's post-merge `collections` map) is required**. `memoryCollections()` unchanged. Old generic-table code path deleted, `table?` option deleted. |
| 10 | Relay `apply` synchrony | All DDL (create/fingerprint/alter) happens at **construction** (async is fine there); `apply` stays synchronous with per-collection prepared statements resolved by a name→statements map. Lazy per-write DDL is forbidden by the seam contract (`collections.ts:89-98`). |

## Invariants that must survive (pinned by conformance + sqlite-specific tests)

1. Cross-collection batch atomicity — one transaction across N tables.
2. Same id in different collections stays distinct.
3. CONFLICT on duplicate insert, NOT_FOUND on absent update, silent no-op absent delete.
4. One clock read per batch (`created_at`/`updated_at` identical across a batch).
5. `RowChange.prev`/`next` are **whole rows** — this is load-bearing beyond the server:
   TanStack DB's adapter hardcodes `rowUpdateMode: 'full'`. No partial row may ever escape.
6. Snapshot results ≡ what the JS evaluator would produce (exactness only when proven).

## Phase 0 — Column plan in core

A pure introspection helper in `@super-line/core` (core already depends on zod; the SQL backends
must NOT grow a zod import):

- `planColumns(def: LwwCollectionDef): ColumnPlan` — walks the Zod shape (with the
  `instanceof z.ZodObject` guard) and returns an abstract plan: per field
  `{ name, kind: 'text'|'real'|'integer-bool'|'json', nullable, isKey }`, plus a stable
  fingerprint string. Non-Zod → the degenerate `{ key, data: json }` plan (fork 3).
- Runtime check that `def.key` names a string field in the shape (the `key: string` looseness
  in `contract.ts:87` means the type system doesn't guarantee it).
- Unit tests over the real-world census shapes: plugin-auth's 5 collections, plugin-chat's 4
  (incl. the host-parametrized `messageSchema` factory output and sparse `messagePartSchema`),
  the `metadata` record idiom, non-Zod fallback.

Backends render dialect DDL/SQL from the plan themselves — core stays SQL-free.

## Phase 1 — sqlite

`packages/collections-sqlite` rewritten around per-collection tables (the package is small; this
is a rewrite, not a patch):

- Construction: for each def, `planColumns` → `CREATE TABLE IF NOT EXISTS "col_<name>"` →
  fingerprint check against `col_meta` (fork 6) → per-collection prepared statements
  (get/insert/update/delete) in a `Map<n, Statements>`.
- `apply`: dispatch each op to its collection's statements inside one `db.transaction()`;
  decompose the validated row into columns per plan; JSON fields via `JSON.stringify`.
  Row reconstruction on read honors fork 5 (omit vs null).
- `snapshot`: compiler v2 — real column refs for planned scalar fields, `json_extract("<jsonCol>",
  '$.rest.of.path')` for dot-paths into JSON columns, exactness tracking, ORDER BY/LIMIT/OFFSET
  push when exact (fork 4). `rowMeta` keeps its shape (now `SELECT` from the one table).
- Tests: `runRowConformance` unchanged and green; sqlite-specific tests updated (pushdown
  correctness incl. the null/missing edges, LIKE fallback, durability across reopen); new tests
  for fingerprint boot-refusal and additive auto-migration. The legacy-table migration test is
  deleted with the shim.
- Call-site sweep: every example/test constructing `sqliteCollections` gains
  `collections: <contract>.collections` (chat-supervisor, collections-chat, advanced-chat, …);
  dev `.db` files deleted.

## Phase 2 — pglite (self tier)

**2a — the missing test harness first.** No test in the repo exercises real Electric replication
for LWW collections (the pglite tests deliberately fake the feed; only the CRDT side has a
Docker-backed heavy-lane test). Build a testcontainers Postgres+Electric integration test for
`collections-pglite` as it exists today (crib from `collections-crdt-pglite.integration.test.ts`
and the store-sync-pglite e2e), pinning: change delivery, origin round-trip, and — critically —
what `live.changes` actually carries per UPDATE. Heavy lane (`vitest.config.ts` list).

**2b — typed tables.** Same plan/DDL as sqlite in Postgres dialect (`text`/`double precision`/
`boolean`/`jsonb`), plus the self-tier specifics:

- **N shapes / N live queries**: one Electric shape + one `live.changes` subscription per
  collection table, key = the natural key column (the synthetic SOH `pk` hack is deleted).
  Teardown loops with aggregated errors. The whole construction DDL phase (creates + fingerprint
  check + additive ALTERs) is serialized cluster-wide behind `pg_advisory_lock`, with the
  swallowed-code taxonomy (42P07/23505/42710, + 42701 duplicate-column) kept as belt-and-braces;
  fingerprint refusal as in fork 6.
- **Full-row reconstruction** (the highest-severity risk found): Electric's `live.changes`
  carries only changed columns + key. The event fires after the local replica applied the
  change, so on UPDATE the backend re-reads the complete row from the **local replica** by key
  (in-memory, by PK) before emitting `RowChange.next`. Invariant 5 holds; `prev` stays absent
  in self mode (prev-less deletes already broadcast to all subs). Pinned by a 2a-harness test
  asserting a one-field UPDATE delivers the full row to subscribers.
- `snapshot` gains the Postgres compiler (fixes the in-code "fetches the whole collection"
  ponytail at `collections-pglite/src/index.ts:129`).

## Out of scope

CRDT collection backends (fork 8) · real SQL FKs (fork 7) · `collections-memory` changes ·
a general migration framework · making SQL pushdown authoritative without proven exactness ·
client/react/tanstack-db changes (none needed — layout is invisible above the seam).
