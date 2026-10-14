# Research: Durable Object SQLite storage API (T03)

Researched 2026-10-14. Every fact carries a source. "Undocumented" means neither the docs pages nor the workerd source answers it.
Source tags: **[API]** https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ · **[LIM]** https://developers.cloudflare.com/durable-objects/platform/limits/ · **[PRICE]** https://developers.cloudflare.com/durable-objects/platform/pricing/ · **[STATE]** https://developers.cloudflare.com/durable-objects/api/state/ · **[ACCESS]** https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/ · **[RULES]** https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ · **[MIG]** https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ · **[BLOG]** https://blog.cloudflare.com/sqlite-in-durable-objects/ · **[WD-AUTH]** https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c++ · **[WD-SQL]** https://github.com/cloudflare/workerd/blob/main/src/workerd/api/sql.c++ · **[WD-BUILD]** https://github.com/cloudflare/workerd/blob/main/build/BUILD.sqlite3 · **[WD-MOD]** https://github.com/cloudflare/workerd/blob/main/MODULE.bazel · **[VITEST]** https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/

workerd sources are the open-source runtime on `main`; production may lag. They are labelled "source" below, not "docs".

## 1. The `ctx.storage.sql.exec` API

- **Shape.** `exec(query: string, ...bindings: any[]): SqlStorageCursor`. Queries may contain `?` placeholders. [API]
- **Binding.** Only positional `?` is documented; named parameters are not mentioned. [API]
- **Multi-statement.** Allowed, separated by semicolons. Bindings apply to the last statement only and the cursor covers only the last statement. [API] Source error: "When executing multiple SQL statements in a single call, only the last statement can have parameters." [WD-AUTH]
- **Binding value types.** Docs: undocumented. Source: `BindingValue = Maybe<OneOf<bytes, string, double>>`, i.e. null, ArrayBuffer, string, number. [WD-SQL header, https://github.com/cloudflare/workerd/blob/main/src/workerd/api/sql.h] Whether a JS `boolean` or `undefined` coerces is undocumented. (collections-sqlite already converts booleans to 1/0 via `norm`, so it is unaffected.)
- **Result types.** `int64` columns come back as JS numbers (doubles) and large values lose precision beyond 52 bits. [API] Source comment: int64 is coerced to double rather than BigInt. [WD-SQL]
- **Cursor.** Iterable and Iterator: `next()`, `toArray()`, `one()` (throws on zero or more than one row), `raw()` (array rows), `columnNames`, `rowsRead`, `rowsWritten` (both feed billing). [API]
- **Row typing.** `exec<T>()` / `raw<T>()` take a type parameter that is not validated at runtime. [ACCESS]
- **No public prepared statements.** `Statement` is not documented. [API] Source: `exec` keeps an internal LRU cache of compiled statements keyed by SQL string, so repeated identical SQL is cheap without `prepare`. [WD-SQL]
- **Cursor isolation.** A cursor held across an `await` has no snapshot isolation and may see later writes, including ones later rolled back. Docs recommend consuming synchronously with `.toArray()`. [API]
- **Large results.** Source: `toArray()` errors on very large result sets; stream with `for...of` or `raw()` instead. [WD-SQL]
- **Reserved names.** Names starting `_cf_` (case-insensitive) are rejected. [WD-SQL `isAllowedName`]
- **Other.** `sql.databaseSize` returns bytes. [API]

### SQLite version and features
- **Version.** Docs: undocumented. Source on `main` builds SQLite 3.53.4 (`sqlite-src-3530400`) with six Cloudflare patches. [WD-MOD] Treat as "recent"; the production pin is undocumented.
- **Compile options (source).** FTS5, MATH_FUNCTIONS, RTREE, ENABLE_UPDATE_DELETE_LIMIT, OMIT_SHARED_CACHE, `SQLITE_DEFAULT_FOREIGN_KEYS=1`. [WD-BUILD] Docs list FTS5 (+`fts5vocab`), the JSON extension and math functions. [API]
- **JSON functions.** `json_extract`, `json`, `json_each`, `json_type`, `json_valid`, `->`, `->>`, plus `coalesce`, `instr`, `lower`, `typeof` are in the function allowlist. Functions not on the list are denied. [WD-AUTH]
- **ALTER TABLE.** Permitted by the authorizer (`SQLITE_ALTER_TABLE`, renames included). [WD-AUTH] The docs' own migration example runs `ALTER TABLE messages ADD COLUMN edited_at INTEGER`. [RULES]
- **Partial indexes, generated columns, `RETURNING`, `NULLS FIRST/LAST`.** The docs do not mention any. Nothing in the authorizer denies them (`CREATE_INDEX`/`CREATE_TABLE` are allowed by name only). [WD-AUTH] They are standard in the 3.53 source build; confirm on a real deploy before relying on one.
- **Virtual tables.** Only `fts5`, `fts5vocab`, `rtree`, `rtree_i32`. [WD-AUTH]
- **Denied.** `ATTACH`/`DETACH`; all TEMP objects; any PRAGMA not on the allowlist; any function not on the allowlist. [WD-AUTH]
- **Allowed PRAGMAs.** `data_version`, `page_size`, `case_sensitive_like`, `foreign_keys`, `defer_foreign_keys`, `ignore_check_constraints`, `legacy_alter_table`, `recursive_triggers`, `reverse_unordered_selects`, `foreign_key_check`, `foreign_key_list`, `index_info`, `index_list`, `index_xinfo`, `quick_check`, `optimize`, `table_list`, `table_info`, `table_xinfo`. [WD-AUTH] So `journal_mode` and `synchronous` are denied. Cloudflare "always configures SQLite to use WAL mode." [BLOG]
- **`PRAGMA user_version` is not supported**; docs track schema versions in a table such as `_sql_schema_migrations`. [RULES via Context7 snippet]

## 2. Transactions

- **`ctx.storage.transactionSync(callback)`** (SQLite-backed only): runs the callback in a transaction, returns its result, rolls back if it throws. Callback must be synchronous. [API]
- **`ctx.storage.transaction(async closure)`**: async variant; for SQLite-backed objects the `txn` object is obsolete and direct `ctx.storage` / `sql.exec` calls are part of the transaction. [API]
- **Raw `BEGIN`/`COMMIT`/`SAVEPOINT` via `sql.exec` are rejected**: "`sql.exec()` cannot execute transaction-related statements like BEGIN TRANSACTION or SAVEPOINT." [API] Source message points to `transactionSync()`. [WD-SQL `allowTransactions`]
- **Atomicity of a multi-statement batch: yes.** `transactionSync` gives all-or-nothing across any tables. Independently, writes with no intervening `await` are coalesced and submitted atomically. [API] [https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/ describes the same coalescing] Cross-table is not restricted; there is one database per DO.
- **Output gates.** The response is held until writes are confirmed durable; a failed write resets the object and replaces the response with an error. `allowUnconfirmed` opts out; `sync()` waits for flush. [BLOG] [API]
- **Nested `transactionSync`** (collections-sqlite nests one transaction inside another in `conditionalApply`): undocumented.

## 3. Limits and cost

- **DB size per DO: 10 GB** (Workers Paid), decimal GB. Storage per account unlimited (Paid) / 5 GB (Free). [LIM] The FAQ on that page says 1 GB per object on Free, contradicting the table; the table is the more recent-looking claim but the page is self-inconsistent. [LIM]
- **Row/value:** key+value 2 MB; max string, BLOB or table row **2 MB**. [LIM]
- **Columns per table: 100.** **Statement length: 100 KB.** **Bound parameters per query: 100.** **Arguments per SQL function: 32.** **LIKE/GLOB pattern: 50 bytes.** Rows per table unlimited within DB size. [LIM]
- **Statement count per request:** no limit documented. CPU is 30 s per request/message/alarm by default, configurable to 5 minutes via `limits.cpu_ms`. [LIM]
- **Pricing (rows):** Paid includes 25 B rows read/month then $0.001 per million; 50 M rows written/month then $1.00 per million; 5 GB-month stored then $0.20/GB-month. Free: 5 M reads/day, 100 K writes/day, 5 GB. [PRICE] Deletes count as writes. Each index update adds at least one row written. [PRICE] [ACCESS] Storage billing was scheduled to start 7 Jan 2026; current status must be checked on the changelog. [PRICE]
- **How scans and indexes count toward rows read:** undocumented beyond "same as D1". [PRICE]
- An empty SQLite DB is about 12 KB. [PRICE]

## 4. Boot, migration, and lifecycle

- **Opt in with `new_sqlite_classes`** in a wrangler `[[migrations]]` entry; only SQLite classes get `sql`. [ACCESS] [MIG] Storage type is immutable once the namespace exists; no KV-to-SQLite path exists yet. [MIG] Newer config uses an `exports` field; once adopted you cannot return to legacy `migrations`, and rollback to pre-`exports` versions is blocked. [MIG]
- **Wrangler migrations do not create tables.** They only provision the class. Tables are created by your code.
- **Constructor.** The docs' basic example runs `CREATE TABLE IF NOT EXISTS` directly in the constructor with no `blockConcurrencyWhile`, since SQL is synchronous. [ACCESS] `blockConcurrencyWhile` is for async init or versioned migrations: it blocks all other events until the callback completes, has a **30 s timeout**, and if it throws or times out "the object will be terminated and reset." [STATE]
- **"Refuse to boot" consequence.** A throw inside `blockConcurrencyWhile` resets the object, so every request keeps failing (matches the MAP fog item). A throw in a plain synchronous constructor: exact behavior undocumented.
- **Migration pattern in docs:** a `_sql_schema_migrations` table checked in `blockConcurrencyWhile`, multi-statement `exec` for DDL. [RULES]
- **Hibernation constants relevant to sizing:** max 32,768 WebSockets per DO. [STATE]

## 5. Backup and PITR

- Whole-database PITR for the past 30 days, including SQL and KV data; on by default for SQLite-backed objects; **not supported in local development**. [API] [BLOG]
- API: `ctx.storage.getCurrentBookmark()`, `getBookmarkForTime(ts)`, `onNextSessionRestoreBookmark(bookmark)` (then typically `ctx.abort()`; returns a bookmark to undo). [API]
- Mechanism: WAL changes uploaded in batches (every 10 s or 16 MB); snapshots keep restore data at about twice DB size; old logs expire after 30 days. [BLOG]
- Each commit is replicated to five followers in other data centers; confirmed once three acknowledge. [BLOG]
- `deleteAll()` is required to fully remove storage; dropping tables is not enough. With compatibility date 2026-02-24 or later it also deletes any alarm. [ACCESS] [API]

## 6. Testing note (relevant to the `test:workers` lane)

- Vitest pool storage isolation is per test file. "Using WebSockets with Durable Objects is not supported with per-file storage isolation"; workaround `--max-workers=1 --no-isolate`. The known-issues page does not mention SQLite-specific behavior. [VITEST]

## 7. API-difference table: collections-sqlite (better-sqlite3) vs DO SQLite

Source read: `packages/collections-sqlite/src/index.ts` (416 lines, single file).

| better-sqlite3 usage in collections-sqlite | DO SQLite equivalent | Gap |
|---|---|---|
| `new Database(opts.file)` (file path or `:memory:`), `db.close()` | `ctx.storage.sql`, supplied by the DO; no path, no close | Factory signature changes: takes a `SqlStorage` (and the `ctx.storage` for transactions), drops `file`. No `close()`. |
| `db.pragma('journal_mode = WAL')`, `db.pragma('synchronous = NORMAL')` | Denied by PRAGMA allowlist; WAL is always on | Delete both calls. Durability is the platform's. |
| `db.exec(ddl)` for `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` | `sql.exec(ddl)`; multi-statement allowed; DDL allowed | None. Table names must not start `_cf_` (ours are `col_*`). |
| `db.prepare(sql)` held in a `Table.stmt` map | No `prepare`; `exec(sql, ...binds)` with an internal LRU cache of compiled statements | Replace prepared-statement objects with SQL strings run through `exec`. Perf parity is source-evidenced, not documented. |
| `.get(id)` returning row or `undefined` | `exec(...).toArray()[0]`; `.one()` throws on 0 rows | Must not use `.one()` for optional reads. |
| `.run(...values)` (positional spread) | `exec(sql, ...values)` | None for call shape. Booleans already normalised by `norm`. |
| `.all(...params)` returning `Record[]` | `exec(sql, ...params).toArray()` | None. Cursor is lazy; always `toArray()` inside sync code. |
| Bound parameters unlimited in practice | **100 bound params per query** | `rowMeta` (`IN (?,...)` over `ids`), `compileExpr` `in`, and `and/or` trees can exceed 100 and must chunk or fall back to JS. |
| Table width unlimited in practice | **100 columns per table** | Insert/update bind `columns + 2` values; collections wider than ~98 schema fields (plus the two `_sl_*` columns) fail. `planColumns` could fall back to the degenerate `_sl_data` layout. |
| Row size up to SQLite default (about 1 GB) | **2 MB per string/BLOB/row** | Large JSON columns or `_sl_data` rows over 2 MB throw. Needs a clear `SuperLineError`. |
| `db.transaction(fn)` (sync, rolls back on throw; nests via savepoints) | `ctx.storage.transactionSync(fn)` | Raw `BEGIN`/`SAVEPOINT` rejected. `conditionalApply` nests `db.transaction` around `applyTx`, and nested `transactionSync` behavior is **undocumented**; restructure to one transaction level. Atomic cross-collection batch otherwise satisfied. |
| Listeners fire after the commit returns | Same ordering available; output gate holds outbound messages until writes are durable | None; actually stronger. |
| `json_extract(col, ?)`, `COALESCE`, `IS ?`, `IN (...)`, `LIMIT ? OFFSET ?` with `-1` | All allowed (functions on allowlist) | None known; `LIKE` is never pushed so the 50-byte pattern cap is moot. |
| `ORDER BY ... NULLS FIRST/LAST` | Not documented; works on 3.30+ and workerd builds 3.53 | Verify on a real deployment; docs silent. |
| Integer columns read as JS numbers; `Date.now()` stored as INTEGER; bool via `v === 1` | int64 returned as double, 52-bit precision | None; epoch ms and 0/1 fit. |
| `col_meta` fingerprint table plus `reconcile()` throwing at boot | Works in SQL; throw inside `blockConcurrencyWhile` resets the DO (30 s timeout) | Drift refusal becomes a permanently failing DO until redeploy. Needs the fog item's story. |
| Sync boot at factory call (tables created on construction) | Constructor can run sync DDL directly; `blockConcurrencyWhile` only for async | Factory must run inside or be handed the DO's `ctx`; boot must finish before first event. |
| `PRAGMA user_version`-style versioning not used | `user_version` unsupported anyway | None; `col_meta` is the right mechanism. |
| Cost: unmetered local disk | Billed rows read/written; indexes and deletes add writes | Per-op cost: insert does a `has` read plus a write plus index writes; `snapshot` full scans bill every row read (counting rule for scans undocumented). |

## Summary answers
- **DB size limit:** 10 GB per Durable Object (Workers Paid), 2 MB per row. [LIM]
- **Multi-statement atomic transactions:** yes, via `ctx.storage.transactionSync` and implicit write coalescing; raw `BEGIN`/`SAVEPOINT` through `sql.exec` are rejected. [API]
- **Biggest gap:** the hard per-query limits (100 bound parameters, 100 columns, 2 MB row) that better-sqlite3 never imposed, followed by undocumented nested-transaction behavior that `conditionalApply` relies on today.
