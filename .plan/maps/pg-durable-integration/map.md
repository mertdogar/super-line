# pg_durable integration

## Destination

A detailed integration report — `spec.md` beside this map — assessing how Microsoft's
**pg_durable** (durable execution inside Postgres: SQL step graphs checkpointed by a
background worker hosting the duroxide runtime) fits super-line's pg-based surface:
`plugin-queue` (durable jobs / cron / slots), `collections-pglite` (the `self`-tier
central Postgres + Electric), and whatever `core` contract surface an integration
needs. The report closes with an adopt / interop / document / pass recommendation per
surface, grounded in a running instance, ready to hand off to a
`pg-durable-integration-impl` map.

## Notes

- **Execution override:** the destination artifact IS a document — ticket
  [Write the integration report — spec.md](tickets/07-write-integration-report.md)
  carries that execution into this map; resolving it writes `spec.md`.
- Skills: `/pg-durable-sql` (the framework's README, mirrored as a local skill),
  `wayfinder-maps:research` for research tickets, `/grilling` + `/domain-modeling`
  for the posture ticket.
- Standing facts to keep in view while working any ticket:
  - pg_durable is **Preview**, PG 17/18 only, needs `shared_preload_libraries`,
    `CREATE EXTENSION`, and a **superuser** background-worker role. Steps are
    SQL/HTTP-shaped (`~>`, `|=>`, `df.if/join/loop/http`).
  - plugin-queue workers are arbitrary **TS closures** honoring `AbortSignal` — no
    SQL step can express one. Any "replace the queue" story has to answer this first.
  - The README says duroxide + duroxide-pg are usable **directly from host languages**
    (Rust/Python/Node) without the extension — possibly the more relevant seam.
  - Docker is available (the integration lane already runs brokers via testcontainers).
- Scope assumption recorded at charting (user away): the three named packages are the
  focus; "like" read as representative — `collections-crdt-pglite` and the plugins
  riding the same Postgres sit in the fog, not out of scope.
- Repo-internal artifact: `spec.md` may cite ADRs and plans freely.

## Decisions so far

- [Deep-dive pg_durable: model, DSL, schemas, operational envelope](tickets/01-pg-durable-deep-dive.md) —
  pg_durable's only surface is SQL (no SDK) on a superuser BGW; npm `duroxide` is a
  real extension-free seam; duroxide-pg's queues ≈ plugin-queue's slot machinery;
  the df.http bridge is Azure-only in released builds. Synthesis + two deep notes
  in `assets/`.
- [Stand up a local pg_durable eval instance](tickets/02-local-eval-instance.md) —
  running as container `pg-durable-eval` on port 54517 (0.2.5-pg17, amd64 under
  emulation); DSL, timers, and cancel verified live; `wal_level=replica` default
  and a `df.instances` doc-drift gotcha recorded in `assets/eval-instance.md`.
- [Map plugin-queue's durability machinery onto pg_durable](tickets/03-queue-machinery-mapping.md) —
  for single-step jobs duroxide buys ~nothing plugin-queue lacks (and drops
  priority/jitter/permanent-errors); its value starts at multi-step workflows.
  Four posture shapes named in `assets/queue-machinery-mapping.md`; a new option
  (separate durable-workflows plugin) added to the grilling ticket.
- [Coexistence with the self tier: pg_durable + Electric on one Postgres](tickets/04-electric-coexistence.md) —
  verified live: clean coexistence, `df.instances` shapes work (partial diffs +
  prev-less deletes = shapes the self tier already handles), RLS doesn't scope
  shapes (server policies must), joint deployment forces PG ≥ 17. Evidence in
  `assets/electric-coexistence.md`.
- [duroxide + duroxide-pg from Node — the extension-free path](tickets/05-duroxide-from-node.md) —
  viable, proven by running it: workers stay plain TS activities (contract
  transfers unchanged), one generic generator wraps a queue job, and its schema
  coexists with `df`/`_duroxide` in one database with zero ceremony. Preview
  rough edges (typings bug, noisy sqlite provider) in
  `assets/duroxide-from-node.md`.
- [Integration posture: adopt, interop, document, or pass — per surface](tickets/06-integration-posture.md) —
  decided with Mert: plugin-queue untouched; the vehicle is a NEW
  duroxide-backed alternative queue built as two layers (workflow kit + thin
  queue) with lifecycle projection, prototyped on this map before the report;
  extension seam is document-only; graduation gated on a real consumer +
  upstream fixes.
- [Prototype: duroxide-backed workflow kit + thin queue](tickets/08-workflow-kit-prototype.md) —
  shape confirmed by Mert against a running artifact (~170-line kit, verbatim
  worker contract, proven crash-resume/cancel/signals); six-item work list for
  the real implementation in `assets/workflow-kit-prototype-findings.md`.
  Prototype at `.scratch/workflow-kit-prototype/`.
- [Write the integration report — spec.md](tickets/07-write-integration-report.md) —
  **[spec.md](spec.md) written; the map is COMPLETE.** No dependency on the
  pg_durable extension, no published dependency on duroxide; the integration is
  a new prototyped-but-unpublished durable-workflows kit beside plugin-queue,
  plus one docs page. Seven next steps sized for a `pg-durable-integration-impl`
  map.

## Not yet specified

<!-- (emptied 2026-08-07: the spike question graduated into the prototype
ticket; the CC-surface and packaging questions were settled by the posture —
document-only extension seam, in-repo unpublished kit until the graduation
gate.) -->

## Out of scope

- Implementing the integration itself — this map ends at the report; building is a
  follow-up `pg-durable-integration-impl` map.
- Non-pg queue/collection backends (memory, sqlite, libsql) and the server↔server
  adapter layer (redis/rabbitmq/zeromq/libp2p) — pg_durable touches none of that.
- Azure HorizonDB-specific deployment guidance.
