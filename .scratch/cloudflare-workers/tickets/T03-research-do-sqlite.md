---
id: T03
title: Research: Durable Object SQLite storage API
labels: [wayfinder:research]
status: closed
assignee: research agent (2026-10-14)
closed: 2026-10-14
blocked-by: []
---

## Question

Establish, from Cloudflare's docs with citations, what the typed-tables port needs:
- `ctx.storage.sql.exec` API: statement shape, parameter binding, result cursors, returned row typing, `ALTER TABLE` support, which SQLite version/features (JSON1, partial indexes, `RETURNING`, generated columns) are available.
- Transactions: `ctx.storage.transactionSync` / implicit transactions, what atomicity a multi-statement batch gets (super-line needs atomic cross-collection batches on one store).
- Limits: row/value size, DB size per DO, statement count, cost model (rows read/written).
- Migration/boot story: when the constructor runs vs when SQL can run, `blockConcurrencyWhile` for DDL, how `new_sqlite_classes` migrations in wrangler config interact with table creation.
- Point-in-time recovery / backup facts worth a doc note.
Compare against what `packages/collections-sqlite/src` does with better-sqlite3 (read it) and list every API difference the port will hit.
Write findings to `.scratch/cloudflare-workers/assets/research-do-sqlite.md`.

## Resolution

Findings: [assets/research-do-sqlite.md](../assets/research-do-sqlite.md).
- DO SQLite is `ctx.storage.sql.exec(sql, ...?binds)` returning a lazy cursor; no public `prepare` (internal statement cache), no file/close/pragma.
- DB size 10 GB per DO; hard SQL limits: 100 columns, 100 bound params, 2 MB per row, 100 KB statement.
- Atomic multi-statement batches: `ctx.storage.transactionSync` (sync callback, rolls back on throw); raw BEGIN/SAVEPOINT are rejected. Nested transactionSync is undocumented.
- journal_mode/synchronous PRAGMAs are denied (WAL always on); ALTER TABLE, JSON functions, CREATE INDEX IF NOT EXISTS are allowed. SQLite 3.53.4 in workerd main source; production version undocumented.
- Wrangler `new_sqlite_classes` only provisions the class; tables are created in code (sync in constructor, or `blockConcurrencyWhile`, 30 s timeout, throw resets the DO). KV-to-SQLite conversion is impossible.
- Billing is per row read/written, indexes add writes; PITR 30 days, not in local dev.
- Biggest port gaps: param/column/row caps hit `rowMeta`/`in`/wide collections; nested transaction in `conditionalApply`; drift "refuse to boot" becomes a failing DO.
- Vitest pool: no WebSockets+DO under per-file storage isolation (relevant to T-lane design).
- Closing table of every better-sqlite3 call vs DO equivalent is at the end of the asset.
