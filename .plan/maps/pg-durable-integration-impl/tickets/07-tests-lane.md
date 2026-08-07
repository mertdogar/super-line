---
type: task
blocked_by: [06]
---
# Test suite and lane placement

## Question

Formalize the scratch harnesses into the kit's real test suite: SQLite-provider
tests where a file DB suffices (fast lane candidates — but mind the native-addon
forks rule), Postgres-provider tests via testcontainers (crash-resume via child
process kill, recovery, cancellation classification, signals, projection rows)
in the **heavy lane** — add the file(s) to the `heavy` list in
`vitest.config.ts`, not just an `.integration.test.ts` suffix. Budgets: both
lanes run serially; keep waits within the conventions the loopback suites use.
`pnpm test` and `pnpm test:integration <name>` both green.

## Done when

Full `pnpm test` passes locally with the new suites in their lanes, and the
crash-resume test demonstrably kills and restarts a real process.

## Answer

Resolved 2026-08-07. Lanes formalized; full `pnpm test` green locally.

**Fast lane** (by staying in the default glob): `test/projection.test.ts` (4)
+ `test/retry.test.ts` (3) — SQLite provider, no Docker, ~8s combined,
stable across repeated runs. duroxide's native addon rides the same forks
pool that exists for better-sqlite3/libsql. One caveat on record: a single
background full-lane run flaked one pre-existing loopback test under load
(not reproducible, not a plugin-workflows test — 3× stable) — consistent
with the lane's quiet-machine budgets, nothing new to chase.

**Heavy lane**: `test/postgres.integration.test.ts` added to the `heavy`
list in `vitest.config.ts` (the real seam, per the lane rule). Shape matches
the pglite sibling: testcontainers `postgres:16`, `inject('dockerAvailable')`
+ `describe.skipIf`, `waitForWith(15_000)` budgets, schema-per-test
isolation (`slwf_crash`/`slwf_jobs`/`slwf_signal` — exercising
`connectWithSchema` as the deployment story). Three tests (~12s after
container boot):

1. **Crash-resume kills a real process**: a `tsx` child
   (`test/crash-worker.ts`) seeds the pipeline and prints `MID-TIMER` once
   the projection shows it parked on the durable timer; the test SIGKILLs
   it, then resumes in-process over the same schema. Orchestration code is
   shared via `test/crash-definitions.ts` (deterministic replay requires
   byte-identical generators), and injected activity counters prove the
   semantics: `countRows` = 0 in the resuming process (fan-out replayed
   from checkpoints), `aggregate` = 1 (only the post-timer step executed).
   tsx joined devDependencies to run the TS child.
2. Cancellation classification + permanent failure on real Postgres
   (reason preserved, exactly one attempt).
3. Durable signal park/resume with the payload on the row.

**Full run**: `pnpm test` exit 0 — fast lane green, heavy lane 158 passed /
6 skipped (pre-existing platform/env skips) in ~152s with the new suite
collected (verified via `vitest list`). `pnpm test:integration
postgres.integration` runs the file alone. Root typecheck + lint green.

The scratch demos (`scratch/*.mjs`) stay — the README references them as
runnable walkthroughs; the test suite is the formal artifact.
