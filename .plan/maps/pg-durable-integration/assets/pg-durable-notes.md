# pg_durable / duroxide — synthesized notes

Resolution asset for the deep-dive ticket. Read this first; the depth lives in two
companions fetched live from upstream on 2026-08-07:

- [pg-durable-upstream-notes.md](pg-durable-upstream-notes.md) — the pg_durable repo
  docs (DSL, schemas, execution model, RLS, GUCs, upgrade story), with
  authoritative-vs-superseded doc layers flagged per claim.
- [duroxide-notes.md](duroxide-notes.md) — the duroxide runtime, duroxide-pg
  provider schema/locking, and the host-language bindings verdict.

Versions at fetch time: pg_durable v0.2.5 (repo created ~Feb 2026) · duroxide
v0.1.30 · duroxide-pg v0.1.34 · npm `duroxide` 0.1.28 · PyPI `duroxide` 0.1.27.
Everything is labeled **Preview**, pre-1.0, ~weekly releases, with open correctness
bugs in exactly the sensitive areas (lock-lease livelock, shutdown leaks, first-boot
migration races).

## The system in one paragraph

A three-layer cake, all Microsoft, all new: **pg_durable** is a pgrx extension whose
SQL DSL (`~>`, `|=>`, `&`, `|`, `?>`/`!>`, `@>`, `df.sleep/wait_for_schedule/
wait_for_signal/http`) builds an in-memory graph that `df.start()` materializes into
`df.nodes`/`df.instances`; a background worker **embedded in the Postgres process**
hosts **duroxide** (a Rust deterministic-replay runtime: orchestrations replay from
history each turn; activities are the at-least-once, idempotent, checkpointed unit
of work) persisting through **duroxide-pg** (its own `_duroxide` schema of
instances/history/queues). Two distinct integration seams exist for super-line:
**(A) the extension's SQL surface** — there is NO host-language SDK; everything is
`df.*` calls over an ordinary pg connection — and **(B) `duroxide` on npm** — the
same runtime embedded in a Node process against the same Postgres provider, no
extension, no superuser worker, no preload.

## Facts that shape the integration question

1. **Seam B is real, not roadmap.** npm `duroxide` 0.1.28 (napi-rs, prebuilt
   binaries, 27 releases, 52-test suite, real downstream consumer). Orchestrations
   are **generator functions** (`function*`/`yield`, deliberately not async/await so
   Rust can drive replay); activities are plain async functions. Near-parity with
   Rust core: timers, sub-orchestrations, external events + durable event queues,
   continue-as-new, cancellation, per-instance KV, tag-routed workers, admin API,
   SQLite + Postgres providers. Known gaps: multi-step blocks can't be raced/joined
   directly (wrap as sub-orchestration), `ctx.race()` caps at 2, no linux-arm64 npm
   binary yet.

2. **duroxide-pg's queue machinery is nearly isomorphic to plugin-queue's.**
   `worker_queue`/`orchestrator_queue` claimed via plpgsql `FOR UPDATE SKIP LOCKED`
   with `lock_token` + `locked_until` (lease) + `attempt_count` (poison detection) +
   `visible_at` (delayed visibility / backoff) — the same shape as queueSlots claims
   with `leaseExpiresAt` and retry backoff. Dispatchers are **pure polling** (100ms
   floor when idle; `orchestration_concurrency`/`worker_concurrency` default 2) —
   confirmed zero LISTEN/NOTIFY in provider source. ⚠ pg_durable's GUC table
   describes `max_duroxide_connections` as covering "LISTEN/NOTIFY dispatch" — a
   contradiction to reconcile on the live instance (extension layer may add it, or
   doc drift).

3. **The activity contract is plugin-queue's worker contract.** At-least-once,
   must be idempotent, cooperative cancellation (`ctx.isCancelled()` ↔ our
   `AbortSignal`). The *orchestration* layer above it adds what plugin-queue lacks:
   checkpointed multi-step flows, durable timers, fan-out/fan-in, sagas-by-hand.
   Orchestration code carries the determinism contract (no wall-clock/random/raw
   I/O; `ctx` equivalents; active nondeterminism detection that fails the turn).

4. **app code can only enter a pg_durable workflow as SQL or HTTP.** A `SQL` node
   runs as a single autocommit statement authenticated as `submitted_by`; `df.http`
   is the only escape to services. **The HTTP egress allow-list is a build-time
   Cargo feature** — released .deb/Docker artifacts only reach Azure domains. Any
   "df.http() calls back into a super-line server" bridge requires a from-source
   build with a custom allow-list. This substantially weakens the bridge shape for
   self-hosted users.

5. **No retry for failed SQL nodes** — a failing statement fails the node chain and
   the instance unless the graph routes around it. Activity-level retry/backoff
   exists but the **numbers are documented nowhere in pg_durable's repo** (inherited
   from the duroxide crate — gap carried forward). HTTP: 2xx ok, 4xx returned as
   data, 5xx/timeout/refused → activity fails and retries.

6. **Scheduling primitives:** `df.sleep(seconds)` (durable timer),
   `df.wait_for_schedule(cron)` (5-field cron, next tick computed at execution time
   via the deterministic clock), recurring jobs = a loop wrapping wait+work
   (continue-as-new per iteration). There is **no schedule registry** — a cron job
   is just a long-lived instance, cancelled via `df.cancel()`.

7. **Operational envelope (seam A):** `shared_preload_libraries` + restart;
   `CREATE EXTENSION` is superuser and must run in the one database named by
   `pg_durable.database` (default `postgres`; one BGW, one database per cluster —
   though `df.start(..., database => ...)` can execute against sibling DBs);
   `pg_durable.worker_role` **must be superuser** (that's the RLS-bypass mechanism);
   `DROP EXTENSION` always needs `CASCADE`; PG17 is the primary target but no
   explicit version matrix is documented (gap); binary upgrades have repeatedly
   **broken in-flight replay** (exact-string input validation) with a documented
   "drain first" policy — accepted pre-1.0 instead of orchestration versioning.

8. **Observability surface for a live view:** `df.instances(id, label, root_node,
   status ∈ pending/running/completed/failed/cancelled, output, submitted_by
   REGROLE, database, created_at, completed_at)` + `df.nodes` (composite PK
   `(instance_id, id)`, physical status + read-time derived skipped/pending) +
   monitoring functions (`df.list_instances` keyset-paginated, `df.instance_nodes`,
   `df.metrics` admin-gated). RLS scopes rows to `submitted_by`. Retention
   reconciliation **deletes** terminal instances (default 30 days, hard 10k cap) —
   any Electric shape on `df.instances` would see periodic delete storms, and the
   RLS-vs-replication-role interaction needs a live check.

9. **State is two eventually-consistent stores**: `df.*` written via SPI in user
   transactions; `_duroxide.*` written by the worker's own pool. `df.*` tables are
   extension-owned; `_duroxide.*` **tables are BGW-migrated at startup**
   (MigrationPolicy::ApplyAll), deliberately outside extension DDL. A super-line
   node embedding duroxide-node (seam B) would point the provider at its own schema
   — multi-tenancy is "pick a different schema name".

10. **`df.vars`** (`{name}` raw-text substitution, per-user RLS) and `$name` result
    capture (escaped, with `$name.*` row-set expansion) are separate systems;
    condition truthiness reads first-column-first-row. Details in the upstream
    notes.

## What this means per downstream ticket

- **Queue-machinery mapping:** compare against seam B first — duroxide-pg's queues
  vs. queueSlots/claims is a like-for-like table; the open question is whether
  duroxide's orchestration layer buys enough (multi-step jobs, durable timers,
  fan-out) to justify a Preview dependency, vs. seam A where workers can't run at
  all (fact 4). *[Retry-defaults gap since resolved — see
  [queue-machinery-mapping.md](queue-machinery-mapping.md): duroxide activities
  do NOT auto-retry; retry is an opt-in orchestration-level RetryPolicy
  (3 attempts, exp 100ms ×2 cap 30s, timeouts never retried).]*
- **Electric coexistence:** facts 7–9. Verify on the live instance: extension +
  Electric on one Postgres, a shape on `df.instances` (RLS + replication role +
  retention deletes), and the LISTEN/NOTIFY contradiction (fact 2).
- **duroxide-from-Node:** existence/maturity is settled (fact 1 +
  [duroxide-notes.md](duroxide-notes.md)); what remains is the fit analysis —
  worker-as-activity sketch, replay contract vs. our worker contract, schema
  coexistence with pgliteCollections.
