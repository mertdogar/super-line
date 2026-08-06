---
type: research
blocked_by: []
---
# Deep-dive pg_durable: model, DSL, schemas, operational envelope

## Question

The local `/pg-durable-sql` skill is only the project README. Read the rest —
USER_GUIDE.md, docs/pg_durable_mvp.md, examples/, and the duroxide / duroxide-pg
repos (all under github.com/microsoft) — and pin down what the README gestures at:

- DSL semantics: `~>`, `|=>`, `df.if()`, `df.join()`, `df.loop()`, `df.http()`,
  `df.vars` (per-user RLS scoping), variable interpolation (`$batch.*`).
- Instance lifecycle: `df.start()` → instance id, `df.instances` / `df.nodes`
  schemas, status values, `df.cancel()`, result retrieval, retention.
- Execution model: the background worker (superuser `pg_durable.worker_role`),
  checkpointing granularity, retry/backoff semantics, what "resume after crash"
  means per step type, timers/scheduling primitives.
- Operational envelope: PG 17/18 only, `shared_preload_libraries`, extension
  installs into the `postgres` database, HTTP egress allow-list policy baked at
  build time, RLS multi-user model (`df.grant_usage`), preview-status caveats.
- The duroxide layer: what the runtime owns (deterministic replay,
  sub-orchestrations, timers) vs. what duroxide-pg owns (state schema
  `duroxide.*`, work queues), and what the host-language story looks like from
  their own docs (feeds ticket 05, which verifies it).

## Done when

`assets/pg-durable-notes.md` exists and a later session can work tickets 03–05
from it without re-reading the upstream docs.

## Answer

Resolved 2026-08-07. Three assets landed:
[pg-durable-notes.md](../assets/pg-durable-notes.md) (the synthesis — read first),
[pg-durable-upstream-notes.md](../assets/pg-durable-upstream-notes.md) (pg_durable
repo docs in depth, authoritative-vs-superseded layers flagged), and
[duroxide-notes.md](../assets/duroxide-notes.md) (runtime, provider schema,
bindings). All fetched live from upstream; pg_durable v0.2.5, duroxide family
v0.1.x, everything Preview.

The headline findings that reshape the effort:

1. **pg_durable has no host-language SDK** — its only surface is `df.*` SQL. But
   **duroxide on npm is real** (0.1.28, generator-based orchestrations, near-parity
   with the Rust core, SQLite + Postgres providers) — a second, extension-free seam
   that puts durable execution *inside a Node process*, which is where super-line's
   workers already live.
2. **duroxide-pg's queues are nearly isomorphic to plugin-queue's slot machinery**
   (`FOR UPDATE SKIP LOCKED` + lock lease + attempt count + delayed visibility,
   pure polling) — the mapping ticket has a like-for-like comparison to make, not
   an impedance mismatch to bridge.
3. **The "df.http() bridge to a super-line server" shape is weaker than assumed**:
   the HTTP egress allow-list is a build-time Cargo feature and released artifacts
   only reach Azure domains — self-hosted users would need a from-source build.
4. Operational envelope for the extension seam: superuser BGW embedded in Postgres,
   one database per cluster, `DROP ... CASCADE` always, in-flight replay has broken
   across upgrades (drain-first policy), terminal instances are reaped by retention
   — all of which matters for the Electric-shape idea on `df.instances`.

Gaps carried to downstream tickets: duroxide's own retry/backoff defaults are
documented nowhere (fetch from docs.rs/duroxide); no explicit PG version matrix;
a LISTEN/NOTIFY doc contradiction to reconcile on the live instance.
