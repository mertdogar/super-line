---
type: research
blocked_by: [01]
---
# duroxide + duroxide-pg from Node — the extension-free path

## Question

The pg_durable README claims durable functions can be authored in Rust, Python, or
Node against duroxide + duroxide-pg directly, persisting state in Postgres with no
extension, no `shared_preload_libraries`, no superuser worker. If that's real, it
may fit plugin-queue better than the extension does: TS workers stay TS, stay in
the super-line server process, and gain checkpointed durability in the shared
Postgres.

The existence/maturity half is already settled by the deep-dive
([duroxide-notes.md](../assets/duroxide-notes.md)): npm `duroxide` 0.1.28 is real,
actively released, generator-based orchestrations with near-parity to the Rust
core — but Preview, with open correctness bugs in locking/replay/migrations.
What remains is the fit analysis:

- API shape: what would a plugin-queue worker look like as a duroxide
  activity/orchestration? Sketch one (mind the generator model — orchestrations
  are `function*`, activities plain async; multi-step blocks must wrap as
  sub-orchestrations to race/join).
- Contract fit: duroxide is deterministic-replay; plugin-queue promises
  at-least-once with idempotent workers honoring `AbortSignal`. Do the models
  compose, or does replay impose constraints on worker code that break the
  existing worker contract?
- Would `duroxide.*` state tables coexist with `pgliteCollections` tables in one
  database without ceremony?

## Done when

A maturity verdict plus an API sketch — or a documented dead-end — in `assets/`.

## Answer

Resolved 2026-08-07 by running the real package (evidence + executed sketch in
[duroxide-from-node.md](../assets/duroxide-from-node.md)). **Viable, not a
dead-end**:

- A worker-shaped orchestration (retrying flaky activity → durable timer →
  fan-out) ran to `Completed` on SQLite **and** on the eval container's
  Postgres via `PostgresProvider.connectWithSchema(url, 'sl_workflows')` —
  which simultaneously proved schema coexistence: `df` + `_duroxide` +
  `sl_workflows` in one database, zero ceremony, pg_durable unaffected.
- **The existing worker contract transfers unchanged** — activities are plain
  async TS with plugin-queue's exact demands (at-least-once, idempotent,
  cooperative cancel via a trivial `isCancelled()`→AbortController shim). The
  generator/determinism constraint isolates to one ~10-line reusable
  orchestration; workers never see it.
- Preview earned its label hands-on: `RetryPolicy.backoff` is typed `number`
  but the engine requires `'exponential'` (fails at runtime with a misleading
  error); the in-memory SQLite provider spams self-recovering deadlock
  warnings; `attempt` isn't exposed to activities.

With this, all three research inputs to the posture grilling are in.
