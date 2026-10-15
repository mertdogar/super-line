---
id: T09
title: Build @super-line/collections-cloudflare (rows on DO SQLite)
labels: [wayfinder:task]
status: closed
assignee: claude session 2026-10-15 (T09)
blocked-by: [T03,T05]
---

## Question

> T03 constraints to design against: 100 bound params/query (chunk `IN` lists), 100 columns/table (refuse wider schemas with a clear error), no raw `BEGIN`/`SAVEPOINT` (reshape `conditionalApply`'s nested transaction onto one `transactionSync`), no pragmas, and **drift refusal must not throw inside `blockConcurrencyWhile`** — surface it as a failing fetch with a readable error instead of resetting the DO.

The `CollectionStore` backend on `ctx.storage.sql`: typed tables via core's `planColumns`, `col_meta` fingerprints + additive auto-ALTER, query pushdown parity with `collections-sqlite`, atomic cross-collection batches via DO transactions. First step is the extract-vs-copy decision for the SQL layer shared with `collections-sqlite` (extract only if the diff is small; record the call). Run the existing backend conformance tests (whatever `collections-sqlite` runs) in the workers lane. Factory requires the contract's post-merge `collections` map like the other SQL backends.

## Resolution

**Built.** `@super-line/collections-cloudflare` 0.1.0 (unreleased): `cloudflareCollections(ctx.storage, contract.collections)` → `RelayCollectionStore`. ESM-only, peers core `>=0.17.0` (same floor as `collections-sqlite`, same logic), excluded from root typecheck and checked by its own tsconfig inside `pnpm typecheck`.

**Extract-vs-copy: extract.** The SQL text layer split cleanly from better-sqlite3, so it moved to `packages/collections-sqlite/src/sql.ts` (pure: statements, filter/order compilation, row encode/decode, fingerprint drift). Both backends run it; the Cloudflare package imports it by relative path and tsup bundles it (a package dependency would install better-sqlite3, which no Worker can load). `collections-sqlite` is refactored onto it with behavior unchanged (33/33) → **owes a patch release** (T13).

T03 constraints, as built:
- 100 bound values: a snapshot filter needing > 98 scans + filters in JS (chunking can't lower one statement's count); `rowMeta` chunks 100 ids/query. Mutation-checked: without the cap the platform throws `too many SQL variables`.
- 100 columns: > 98 planned columns → that collection is unusable (readable error); 98 columns + 2 timestamps insert fine.
- Transactions: one `transactionSync` per `apply` / `conditionalApply` (check-then-apply). A `SuperLineError` keeps its identity through the rollback.
- Drift never throws at construction: the store opens lazily; a collection that can't open fails only its own operations with `INTERNAL` "cloudflareCollections: collection 'x' is unusable: schema changed or removed field 'n' — rename the collection, or migrate table "col_x" and its col_meta row in code". Additive drift auto-ALTERs.
- No pragmas used. `NULLS FIRST/LAST` verified under workerd; `RETURNING` unused.

Tests (workers lane, `test-workers/collections-cloudflare.workers.test.ts`, 37): the shared row conformance suite + sqlite's own pushdown checks inside `runInDurableObject` via `aroundEach` (new bare `StoreNode` DO); limits; drift; rows survive eviction; and end to end, `AppNode` now carries a `notes` collection — a live row subscription survives a wake and the woken node still has every row, zero client lifecycle events. Lanes: workers 52/52, fast 854/854; typecheck + lint clean; both packages build.

Also: CLAUDE.md (layout, typecheck exclusions, DO-storage-in-tests gotcha), all four `skills/super-line/` files, PLAN-cloudflare "As built (T09)". README is T12's.
