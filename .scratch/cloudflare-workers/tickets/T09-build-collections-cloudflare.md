---
id: T09
title: Build @super-line/collections-cloudflare (rows on DO SQLite)
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [T03,T05]
---

## Question

> T03 constraints to design against: 100 bound params/query (chunk `IN` lists), 100 columns/table (refuse wider schemas with a clear error), no raw `BEGIN`/`SAVEPOINT` (reshape `conditionalApply`'s nested transaction onto one `transactionSync`), no pragmas, and **drift refusal must not throw inside `blockConcurrencyWhile`** — surface it as a failing fetch with a readable error instead of resetting the DO.

The `CollectionStore` backend on `ctx.storage.sql`: typed tables via core's `planColumns`, `col_meta` fingerprints + additive auto-ALTER, query pushdown parity with `collections-sqlite`, atomic cross-collection batches via DO transactions. First step is the extract-vs-copy decision for the SQL layer shared with `collections-sqlite` (extract only if the diff is small; record the call). Run the existing backend conformance tests (whatever `collections-sqlite` runs) in the workers lane. Factory requires the contract's post-merge `collections` map like the other SQL backends.
