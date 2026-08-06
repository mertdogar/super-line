# pg_durable / duroxide — integration report for super-line

**Status:** complete · **Date:** 2026-08-07 · **Map:** `.plan/maps/pg-durable-integration/`

Repo-internal document. Every claim below is either **verified live** on a running
instance or **sourced** to upstream docs fetched during this effort; the two are
distinguished throughout. Evidence lives in `assets/` beside this file.

---

## 1. Summary

Microsoft's pg_durable brings durable execution *inside* PostgreSQL. Assessing it
for super-line's Postgres-based surface turned up a fact the headline hides:
**pg_durable is the least interesting of the three products in its stack.** The
extension can never run super-line's TypeScript workers — its steps are SQL or
HTTP, full stop — but the Rust runtime underneath it, **duroxide**, ships a real,
published Node binding that embeds the same durable engine *inside a Node
process*, persisting to the same shared Postgres a `self`-tier deployment already
runs.

Verdicts:

| Surface | Posture | Why |
|---|---|---|
| **`plugin-queue`** | **Untouched** | For single-step jobs the duroxide engine buys nothing plugin-queue lacks, and loses priority, jitter, permanent-error short-circuiting, per-queue concurrency, and jobs-as-live-rows. Swapping its engine would trade working features for a Preview-grade native dependency. |
| **New durable-workflows kit** (the actual integration) | **Build, prototyped, unpublished** | A *new* duroxide-backed surface in two layers — a workflow kit (activities + generator orchestrations) with a thin queue API on top. This is where duroxide's real value lands: checkpointed multi-step jobs, durable timers, signals, fan-out. Prototype built and confirmed; publication gated. |
| **`collections-pglite` / the `self` tier** | **Document only** | pg_durable and Electric coexist cleanly on one Postgres (verified). Watching `df.instances` through an Electric shape works. But that value is a *how-to page*, not shipped code — the extension's audience is narrow and its table shapes drift. |
| **`core`** | **No change required** | Everything the new kit needs already exists: `defineContractPlugin` for the contract fragment, the server plugin `PluginContext` for collections and conditional batches. The one idea that *would* have touched core — teaching collections-pglite to sync a foreign table — is not being built. |

The single most important line in this report: **super-line takes no dependency
on the pg_durable extension, and no *published* dependency on duroxide, until a
real consumer needs it and upstream's open correctness bugs are closed.**

---

## 2. What pg_durable actually is

### 2.1 Three layers, not one

Upstream ships a stack that the marketing collapses into one name:

- **`duroxide`** — a Rust durable-task runtime. Orchestrations are replayed from
  an event history on every turn; activities are the at-least-once, idempotent,
  checkpointed unit of side-effecting work. Deterministic-replay engine with
  active nondeterminism detection.
- **`duroxide-pg`** — the PostgreSQL state provider for that runtime. Owns a
  schema of instances / executions / history / work queues.
- **`pg_durable`** — a pgrx **extension** that hosts duroxide in a Postgres
  background worker and exposes a SQL DSL for authoring workflows as step graphs.

The extension has **no host-language SDK** — its entire surface is `df.*` SQL
functions and operators. But `duroxide` and `duroxide-pg` are usable directly
from Rust, Python, and **Node** — and the Node binding is real: npm `duroxide`
0.1.28, napi-rs with prebuilt per-platform binaries, 27 releases, a 52-test
suite, feature parity close to the Rust core.

Everything in the family is **Preview**, pre-1.0 (v0.1.x), releasing roughly
weekly, with open correctness bugs in exactly the load-bearing areas: lock-lease
livelock, `shutdown` not stopping child tasks, first-boot migration races.

### 2.2 The extension, seen from a running instance

Verified on `ghcr.io/microsoft/pg_durable:0.2.5-pg17` (PostgreSQL 17.10):
the quick-example DSL, a fan-out `&`-join with `$name` result capture, an 8s
durable timer, and `df.cancel()` all behaved as documented. Two measurements
worth carrying forward:

- **~1.6–1.9s of orchestration overhead** on a trivial graph (under emulation).
  Each activity is a checkpoint round-trip through queue tables polled at a
  100ms floor. This is background-work machinery, not a request path.
- The worker holds **~26 client backends** at defaults (management 6 + duroxide
  10 + user 10) before anything else connects.

Operationally the extension asks for a lot: `shared_preload_libraries` plus a
restart, `CREATE EXTENSION` as superuser in the one database named by
`pg_durable.database`, a **superuser** background-worker role (that's the
RLS-bypass mechanism, by design), `DROP EXTENSION ... CASCADE` unconditionally,
and PG 17/18 only. Upgrades have repeatedly **broken in-flight replay** —
upstream's documented policy is to accept that pre-1.0 and tell operators to
drain instances first.

### 2.3 Documentation drift, and why it matters

Upstream's `main`-branch docs describe a `df.instances` table with an `output`
column. **Released 0.2.5 has no such column** — results live on terminal nodes
and surface through `df.result()`. Anything reading `df.instances` directly must
expect its shape to move between extension versions. This is a small fact with a
large consequence: it is one of the reasons the live-view idea stays a documented
recipe rather than shipped code.

---

## 3. Per-surface analysis

### 3.1 `plugin-queue`

The mapping was done mechanism by mechanism against the source
(`packages/plugin-queue/src/index.ts`). The structural surprise: **duroxide-pg's
work queues are nearly isomorphic to plugin-queue's slot machinery** — claims via
`SELECT ... FOR UPDATE SKIP LOCKED`, a `lock_token` + `locked_until` lease, an
`attempt_count` for poison detection, and `visible_at` for delayed visibility.
super-line expresses the same design in TypeScript over `conditionalBatch`
revision fences; duroxide expresses it in plpgsql. Neither is better; they are the
same idea twice.

What each side has that the other lacks:

**plugin-queue has, duroxide lacks:** priority ordering (duroxide claims FIFO by
id); retry jitter; a permanent-error short-circuit (`PermanentJobError`);
timeout-counts-as-an-attempt (duroxide never retries a timeout, only errors);
per-queue concurrency (duroxide's pools are per-runtime); the cron **policy
registry** — misfire policy, catch-up limits, overlap policy, occurrence dedup,
pause/resume (duroxide has timers but no cron primitive at all); jobs as
contract-validated live collection rows, which is what gives Control Center and
client UIs a view for free; and zero native dependencies.

**duroxide has, plugin-queue lacks:** checkpointed **multi-step** jobs — a crash
mid-job resumes after the last completed step instead of re-running the worker;
durable timers spanning days without holding a process; deterministic fan-out and
sub-orchestrations; external events (signal a running job); continue-as-new; a
per-instance KV store; and a full replayable history of every step.

That split is the whole argument. plugin-queue's contract models **single-step
jobs**, and for those, duroxide's engine is a lateral move that costs real
features. Its value begins precisely where jobs stop being single-step — which is
a *different product*, not a better backend.

Correction worth recording, since pg_durable's own docs imply otherwise:
**duroxide activities do not auto-retry.** Retry is an opt-in orchestration-level
`RetryPolicy` (defaults: 3 attempts, exponential 100ms ×2 capped at 30s), and a
timed-out attempt exits immediately rather than retrying.

### 3.2 `collections-pglite` and the `self` tier

Everything the ticket asked was tested live: pg_durable 0.2.5 and
`electricsql/electric` against one PostgreSQL 17 instance with
`wal_level=logical`.

**Coexistence is clean.** Workflows ran normally with Electric's replication slot
active and streaming. No preload or GUC conflicts, no interference in either
direction.

**`df.instances` is watchable through an Electric shape.** A workflow's full
lifecycle arrived as row messages: `insert` (pending, full row) → partial-diff
`update` (running) → `update` (completed). Both awkward Electric behaviours here —
partial diffs and key-only, prev-less deletes — are exactly the ones
collections-pglite already compensates for (full-row re-read; prev-less deletes
broadcast to all subscribers, per ADR-0006's routing rules). Electric
auto-configures the table: adds it to its publication and sets `REPLICA IDENTITY
FULL` on an extension-owned table (benign, but an `ALTER EXTENSION UPDATE` that
rebuilds the table would drop it).

**RLS does not scope a shape.** Logical decoding ignores row-level security, so
the shape carries every user's instances regardless of `submitted_by`. Scoping
must come from super-line's server-side read policies — which is the
server-authoritative collections model anyway. What is ruled out is leaning on
Postgres RLS as the visibility layer for synced rows.

**The version envelope moves.** pg_durable requires PG 17/18; the self-tier
integration tests currently run `postgres:16`. Joint deployment forces PG ≥ 17.
Electric on 17 is verified working. `collections-crdt-pglite`, `plugin-auth`, and
`plugin-chat` riding the same Postgres inherit only this note — coexistence is
clean, so they need no further accommodation.

One capability gap, if a live view were ever built: collections-pglite syncs only
its **own** `col_*` tables, created from contract schemas and fingerprint-gated
(see `docs/plans/PLAN-collections-typed-tables.md`). Watching a foreign,
extension-owned table whose shape drifts across releases is a genuinely new
mechanism — either a read-only external-table mode in the backend, or a
server-side poller projecting into a normal collection. Neither is being built
(§4.3).

### 3.3 `core`

No change is required, and this is a positive finding rather than an absence.
The contract-fragment plugin boundary (ADR-0005 for the runtime half, ADR-0016
for the contract half) already provides everything a new durable-workflows kit
needs: `defineContractPlugin` to contribute a `workflowRuns` collection and any
requests, `ResolveContract`'s plain intersection so `RowOf`/`client.collection`
infer with no type-threading, and the server `PluginContext` for collection
handles and `conditionalBatch`. The kit is a plugin like `queue()`, `auth()`, and
`chat()` — not a core extension.

---

## 4. The decided posture

Settled with Mert on 2026-08-07. The framing that survived scrutiny: **don't
retrofit, build beside.**

### 4.1 plugin-queue stays untouched

No engine swap, no extension-backed mode. It remains the simple, zero-native-dep
job engine, and its ADR-0023 semantics (an unbound queue is skipped on a node,
never failed) are unaffected.

### 4.2 The integration is a new duroxide-backed kit, in two layers

- **Layer 1 — workflow kit.** duroxide's model wired super-line-style: activities
  are plain async TypeScript functions; orchestrations are generator functions;
  the kit exposes `contract` and `plugin` halves like every other paired plugin.
- **Layer 2 — thin queue API** on top: `enqueue` / `get` / `cancel` over a
  generic job-wrapper orchestration carrying a retry policy. A queue worker is a
  plugin-queue worker, verbatim.
- **Observability = lifecycle projection.** The kit co-writes a `workflowRuns`
  collection at lifecycle transitions, including duroxide's custom status as
  step-level progress. Runs become live rows, so a Control Center view and client
  subscriptions come for free. Step-level history stays behind duroxide's admin
  API, surfaced through host-owned requests the way plugin-queue does.

### 4.3 The pg_durable extension gets documentation, not code

A "pg_durable beside super-line" how-to: the verified coexistence facts, the
PG ≥ 17 envelope, and the working Electric-shape recipe for watching
`df.instances`. The interop kit (requests for `df.start`/`df.cancel`/`df.status`
plus a live instances view) is recorded as **proven feasible** and deliberately
not built — its audience runs a superuser background worker on PG 17+ (in
practice, Azure-leaning), and its table shapes drift release to release.

### 4.4 Graduation gate

The kit stays **in-repo and unpublished** until **both**: a concrete host
actually needs it, and duroxide's open correctness bugs in locking, replay, and
shutdown are closed. Publishing an npm package that tracks a weekly-breaking
Preview would import upstream's instability into super-line's release surface —
and this repo's own rules make that expensive (a source change to a published
package is a release, not an option).

---

## 5. What the prototype revealed

The kit was built rather than imagined: `.scratch/workflow-kit-prototype/`
(`node demo.js` for crash-resume, `node demo2.js` for cancel and signals). Mert
reacted to it live; the shape was confirmed after two requested iterations.

**It is small.** The two-layer skeleton is roughly 170 lines. The per-queue
wrapper orchestration is six.

**The worker contract transfers verbatim.** A queue worker stays
`(input, { signal }) => Promise<Result>`. The determinism constraints that make
duroxide work — no `await` in orchestrations, no wall-clock, no randomness — land
only on orchestration authors, and for queue-shaped work that is one reusable
generator nobody else reads.

**Crash-resume is real, and observable.** A fan-out completed, the process was
`SIGKILL`ed mid-durable-timer, and on restart only the *remaining* activity
executed — the fan-out results replayed from checkpoints, provable in the event
history where their `ActivityCompleted` events predate the crash. Crash-orphaned
work items self-healed on the next boot.

**Signals and cancellation work.** Durable event queues park and resume a
workflow cleanly (the approval / human-in-the-loop pattern). Cancellation goes
terminal about a second after the call, and the in-flight activity's abort shim
fires for cooperative cleanup.

**Six frictions the real kit must own** — the work list, not blockers:

1. **No lifecycle hook.** duroxide-node exposes no server-side event on status
   change, so projection is a per-instance polling watcher. `getStatus` also
   returns `notfound` transiently before an instance's first turn; that must read
   as still-starting, not missing.
2. **Recovery reads durable rows.** After a restart the kit re-arms watchers for
   non-terminal instances; run metadata (name, kind, input) must come from the
   persisted collection.
3. **A normalization layer is mandatory.** duroxide output is double-JSON-encoded,
   statuses are capitalized, and custom status survives past terminal states.
4. **No distinct `cancelled` status.** Cancellation lands as `failed` with an
   error string of `canceled: <reason>`; the kit must classify it back for parity
   with plugin-queue.
5. **Tracing must be routed.** The Rust `tracing` layer writes to stderr by
   default; ADR-0018 says diagnostics go through LogTape, so the kit should call
   `initTracing` and bridge.
6. **Retry semantics differ** (carried from the analysis): `RetryPolicy.backoff`
   is typed `number` but the engine requires the string `'exponential'` — a
   published typings bug that fails at runtime with a misleading error;
   `timeoutMs` is required; timeouts never retry; no jitter, no permanent-error
   class. If parity with plugin-queue matters, the queue layer reimplements them.

---

## 6. Recommended next steps

Sized for a follow-up `pg-durable-integration-impl` map, in dependency order:

1. **The docs page** (independent, shippable now, no dependency risk):
   "Running pg_durable beside super-line" — coexistence, the PG ≥ 17 envelope,
   the Electric-shape recipe, and an honest boundary statement about what belongs
   in SQL workflows versus the app tier. Published pages name no ADR or plan;
   state the behaviour.
2. **Name and scaffold the kit** — package identity, the contract fragment
   (`workflowRuns` schema and indexes), and the peer-dependency shape. Note that
   `duroxide` is an *external* native dependency, so the repo's internal-peer-dep
   rule does not apply to it, but the napi platform-binary story (no linux-arm64
   published yet) needs a supported-platforms statement.
3. **Harden the projection** — items 1–4 of the friction list: the polling
   watcher with `notfound` tolerance, recovery from durable rows, the
   normalization layer, and cancellation classification.
4. **Decide the retry-parity question** — either reimplement plugin-queue's
   semantics (jitter, permanent errors, timeout-as-attempt) in the queue layer,
   or document the divergence. This is a real design decision, not mechanical
   work; it deserves its own ticket.
5. **LogTape bridge** for duroxide's tracing (ADR-0018).
6. **Tests and lane placement** — the kit needs a real Postgres, so it belongs in
   the `heavy` list in `vitest.config.ts` alongside the other Docker-backed
   suites, not the fast lane.
7. **Re-check the gate before any publish** — upstream bug status and whether a
   consumer materialized. Until then the kit ships to nobody.

Deliberately **not** on this list: an interop kit for the extension, a Control
Center view for `df.instances`, any change to plugin-queue, and any core change.

---

## 7. Evidence index

| Asset | What it holds |
|---|---|
| `assets/pg-durable-notes.md` | Synthesis of the framework: the three layers, the ten facts that shaped the effort. |
| `assets/pg-durable-upstream-notes.md` | pg_durable repo docs in depth — DSL, schemas, execution model, RLS, GUCs, upgrades — with authoritative-vs-superseded doc layers flagged per claim. |
| `assets/duroxide-notes.md` | duroxide runtime, duroxide-pg provider schema and locking, the host-binding verdict with registry evidence. |
| `assets/eval-instance.md` | Repeatable bring-up of the eval container, transcript, and the `df.instances` doc-drift discovery. |
| `assets/queue-machinery-mapping.md` | Per-mechanism owns/interops/can't-express table for both seams, and the four candidate shapes. |
| `assets/electric-coexistence.md` | The live coexistence test: repro, shape-log messages, RLS finding, version envelope. |
| `assets/duroxide-from-node.md` | The hands-on Node probe: executed worker-as-activity sketch, schema coexistence, Preview rough edges. |
| `assets/workflow-kit-prototype-findings.md` | What building the two-layer kit taught — the six frictions and the confirmed shape. |

Verified live: coexistence, shape behaviour, crash-resume, cancellation, signals,
schema coexistence, the extension's DSL and timers. Sourced from upstream docs:
retry policy internals, upgrade/replay history, GUC defaults, RLS design.
