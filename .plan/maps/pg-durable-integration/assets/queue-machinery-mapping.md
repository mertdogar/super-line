# plugin-queue durability machinery → pg_durable / duroxide mapping

Resolution asset for the queue-machinery-mapping ticket. Inputs:
`packages/plugin-queue/src/index.ts` (read in full, v0.2.0 line), the deep-dive
assets ([pg-durable-notes.md](pg-durable-notes.md) + companions), the live eval
instance ([eval-instance.md](eval-instance.md)), and duroxide's retry-policy doc
fetched this session (`docs/proposals-impl/activity-retry-policy.md`, status
Implemented).

Two seams are mapped separately — they are different products:

- **Seam A: the pg_durable extension** — SQL-authored workflows executed by a
  superuser BGW inside Postgres.
- **Seam B: duroxide-node embedded** — the npm `duroxide` runtime running inside
  the super-line server process, state in shared Postgres via duroxide-pg.

## Correction to the deep-dive

pg_durable's docs say a 5xx/timeout makes "the activity fail and duroxide retry."
duroxide's own docs are sharper: **activities fail immediately by default**;
retry is an opt-in `RetryPolicy` on `schedule_activity_with_retry()` implemented
in orchestration code (deterministic loop + timer). Defaults *when used*:
`max_attempts: 3`, backoff `Exponential{base: 100ms, ×2.0, max: 30s}`, optional
per-attempt timeout — and **a timeout attempt is never retried** (immediate
exit); only activity *errors* retry. Whether pg_durable passes a policy for its
SQL/HTTP activities is unverified upstream implementation detail. (Separately,
duroxide-pg's queue layer redelivers *crashed* work items via lease expiry +
`attempt_count` — infrastructure redelivery, not logical retry.)

## Mechanism inventory (from source) → per-seam verdict

| plugin-queue mechanism (source of truth) | Seam A: pg_durable extension | Seam B: duroxide-node embedded |
|---|---|---|
| **TS worker closures** — `worker(input, {jobId, attempt, signal})`, bound per node via `setWorker`; unbound queue = skipped, never failed (ADR-0023) | **Can't express.** Steps are SQL or HTTP only. The one bridge, `df.http()` → super-line endpoint, is crippled for self-hosters: released builds' egress allow-list is Azure-domains-only, baked at build time | **Owns cleanly.** A worker becomes a plain async activity; at-least-once + idempotent + cooperative cancel (`ctx.isCancelled()` polled ↔ our `AbortSignal`, thin shim). ADR-0023 skip-not-fail maps to tag-based worker routing (`activity_tags`) — mostly |
| **Job rows** — `queueJobs` collection: contract-validated input/result, priority, `availableAt` (delayed), retry links (`retryOf`/`rootJobId`), schedule links | **Interop at best.** `df.instances` is RLS-scoped, shape drifts across versions (0.2.5 has no `output` column), results only via `df.result()` | **Partial.** Instances + history + KV exist but are duroxide-internal tables + admin API, **not super-line collections** — live UI/CC needs a projection layer. **No priority**: `worker_queue` is claimed `ORDER BY id` (FIFO); `visible_at` covers delayed jobs |
| **Slot claims** — `queueSlots` (`queue:index`), per-queue concurrency, optimistic CAS via `conditionalBatch` revision fences | **N/A** — internal to `_duroxide`, invisible, not per-queue | **Owns.** `FOR UPDATE SKIP LOCKED` + `lock_token`/`locked_until` replaces slots/CAS wholesale — but concurrency is **per-runtime** (`worker_concurrency`), not per-queue; per-queue pools would lean on tags/sessions |
| **Leases + heartbeat + reap** — `leaseMs` (30s), heartbeat at lease/3, `reap()` re-queues expired leases as retries | **N/A** (internal) | **Owns.** `locked_until` lease + `abandon_work_item(delay)` + `attempt_count` poison detection — same design, theirs is in plpgsql. Open upstream bugs here (lock-lease livelock duroxide#46) |
| **Poll + wake** — 1s poll + cluster-bus `wake` channel hints via adapter | **N/A** | **Mostly owns.** Pure polling, 100ms idle floor, no LISTEN/NOTIFY — our adapter-based wake hint has no hook; latency comparable anyway |
| **Retry/backoff** — `maxAttempts` 3, fixed/exponential + **jitter 0.2**, `PermanentJobError` short-circuit, invalid result ⇒ permanent, **timeouts retry** | **No.** SQL node failure fails the instance; no retry, no permanent-error class | **Divergent semantics.** `RetryPolicy` maps maxAttempts/backoff but: no jitter, **timeouts never retry**, no permanent-error class (any `Err` retries). Both fixable with a hand-built orchestration retry loop — which is exactly the code plugin-queue already has |
| **Cancellation** — CAS cancel queued; running → `cancelRequestedAt` + `cancel` channel → abort; heartbeat double-checks | **Owns** (`df.cancel`, cascades, verified live) | **Owns** (`client.cancelInstance`, cascades to children, cooperative in activities) |
| **Cron schedules** — `queueSchedules` registry: 5-field cron + IANA tz, `misfirePolicy` latest/skip/all, `maxCatchUp`, `overlapPolicy`, minute-keyed occurrence dedup, pause/resume/trigger, CAS so one node advances | **Partial.** `df.wait_for_schedule(cron)` in a loop = a *running instance*, not a registry row — no misfire/catch-up/overlap policy, no pause/resume (cancel + restart), no dedup key | **Can't express directly.** duroxide has timers, **no cron primitive** — a cron loop is buildable (deterministic `utcnow` + timer + continue-as-new, as pg_durable did), but the whole policy layer (misfire/catch-up/overlap/registry) would be rebuilt on top. Our schedule machinery survives either way |
| **Retention** — per-status `deleteAt` (24h/7d/24h), reaped | **Owns-ish.** Global reconciliation (30d default + hard 10k cap), not per-status/per-queue | **Weak.** Deletion/pruning APIs exist (migration 0010); no per-status policy — would be our loop calling their admin API |
| **Observability** — deny-all collections + host-owned requests + CC feed; jobs are live rows | **Interop maybe** — pending the Electric-shape verdict (coexistence ticket) | **Gap.** Needs a projection from duroxide state to collections (or keep our rows as a mirror — two sources of truth) |
| **Cluster correctness** — everything above rides `conditionalBatch` on the shared `CollectionStore` (pgliteCollections ⇒ cluster-wide) | N/A — different state domain entirely | **Owns.** duroxide-pg is exactly a shared-Postgres coordination layer; multiple embedded runtimes share queues safely (that's its job). Coexists beside `col_*` tables in its own schema — but it's a **second migration system** in the host's database |

## What each side has that the other lacks

**plugin-queue has, duroxide lacks:** priority ordering; jitter; permanent-error
short-circuit; timeout-counts-as-attempt; per-queue concurrency; the cron policy
registry; jobs-as-live-collections (CC/UI for free); contract-validated
input/result; zero native dependencies.

**duroxide has, plugin-queue lacks:** multi-step checkpointed jobs (a crash
mid-job resumes at the last completed step instead of rerunning the worker);
durable timers spanning days; sub-orchestrations / deterministic fan-out;
external events (signal a running job); continue-as-new; per-instance KV;
history/audit of every step.

That last column is the honest headline: **for single-step jobs — which is what
plugin-queue's contract models — duroxide's engine buys almost nothing we don't
already have**, while costing a Preview-grade native dependency (napi binaries,
no linux-arm64 yet, live locking/replay/migration bugs) and an observability
projection layer. Its value begins exactly where jobs stop being single-step.

## Candidate shapes (for the posture grilling)

- **S1 — Complementary, document the boundary.** pg_durable runs beside
  super-line against the same Postgres for in-database batch/AI-pipeline work;
  plugin-queue stays the app-tier job queue. A how-to page, zero code. Honest
  today; costs nothing; revisit at duroxide 1.0.
- **S2 — Interop surface.** A kit/contract fragment to start/cancel/observe
  pg_durable instances through super-line (live view hinges on the
  Electric-coexistence verdict). Only meaningful for hosts that install the
  extension (PG17+, superuser BGW — a tall order outside Azure).
- **S3 — Swap plugin-queue's engine for duroxide-node.** Keep the API, replace
  slots/claims/lease/backoff with duroxide + duroxide-pg on shared Postgres.
  Verdict from the table: **poor trade today** — loses priority/jitter/permanent
  errors/per-queue concurrency, gains nothing for single-step jobs, adds a
  Preview native dep and a second source of truth for job state.
- **S4 — A separate durable-workflows plugin on duroxide-node.** New capability
  (multi-step, timers, signals, fan-out) as its own opt-in plugin, plugin-queue
  untouched; jobs can enqueue workflows and vice versa. This is where duroxide's
  actual value lands without breaking the simple thing. Cost: the Preview-grade
  dependency and the projection layer, taken on deliberately in a new surface
  rather than under an existing one.

Suggested frame for the grilling: S1 is free and true now; S4 is the growth path
if durable *workflows* (not queues) are wanted; S3 is not worth it pre-1.0; S2
rides on the coexistence ticket's findings.
