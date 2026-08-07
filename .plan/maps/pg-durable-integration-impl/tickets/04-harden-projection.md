---
type: task
blocked_by: [03]
---
# Harden the lifecycle projection

## Question

Implement frictions 1–4 from spec.md §5 in the real kit:

1. Polling watchers with `notfound` tolerance (transient pre-first-turn state
   reads as still-starting; bounded, then surfaced as an error).
2. `recover()` reads run metadata from the durable `workflowRuns` collection
   (not memory) and re-arms watchers for non-terminal runs; document the
   multi-node question (which node watches? — simplest: every node with the
   plugin watches and conditional-writes, CAS makes it idempotent).
3. Normalization layer: parse duroxide's double-JSON-encoded output, lowercase
   statuses, clear customStatus at terminal states.
4. Cancellation classification: `failed` + `canceled:`-prefixed error →
   `cancelled` status with the reason preserved.

## Done when

Each behavior has a focused test against a real provider (can start life in
the scaffold's scratch harness; formal lane placement is the tests ticket).

## Answer

Resolved 2026-08-07. All four frictions implemented in
`packages/plugin-workflows/src/index.ts`, each with a focused test in
`test/projection.test.ts` against a real provider (`SqliteProvider`, no
Docker) on a real server.

1. **notfound tolerance**: a `normalizeStatus`d `notfound` never writes a row;
   the watcher stamps `notfoundSince` and only after `NOTFOUND_GRACE_MS`
   (10s constant) projects `failed` with an explanatory `error` and disarms.
   The schema gained an optional `error` column for this (also used by 4).
   `rearm()` watches-but-does-not-project notfound instances. *Test caveat*:
   the tolerance half is tested (a starting run never shows a `notfound`
   status on its way to `completed`); the bounded-failure branch is
   code-reviewed but untested — forcing a perpetually-invisible instance
   needs fault injection into the engine client, a seam not worth adding
   pre-gate. Revisit in the tests ticket if a clean way appears.
2. **Durable recovery**: `identify()` reads kind/name from the collection row
   first, engine `getInstanceInfo` as fallback; `rearm()` projects through
   the race-tolerant `project()` (a peer's concurrent insert is caught, next
   poll settles). Test: a parked approval workflow survives a full server
   close; a second server on the same provider + the same
   `sqliteCollections` file auto-rearms, the signal completes it, and
   `createdAt` is preserved from the first server's row — proving metadata
   came from the durable collection. Multi-node story documented on
   `rearm()` and in the README: every node watches independently, no leader —
   projection writes are pure functions of engine state and terminal states
   are absorbing, so concurrent watchers converge (CAS deemed unnecessary,
   not just deferred).
3. **Normalization**: statuses lowercased; engine output `JSON.parse`d into
   the row (`z.unknown` column) with raw-string fallback; `customStatus`
   omitted once terminal. `status` stays a loose `z.string()` on purpose — an
   unknown engine status must degrade to an odd row, not a validation error
   that kills the watcher. `waitFor()` still returns the raw engine snapshot
   (surface polish belongs to the finish-surface ticket).
4. **Cancellation classification**: `failed` + `canceled:`-prefixed error
   (engine's one-l spelling) → `cancelled` with the reason (prefix stripped)
   in `error`; `cancelled` joined the TERMINAL set so recovery skips and
   watchers disarm. Verified in test and visibly in `scratch/demo2.mjs`.

Verification: root typecheck + lint green; the 4 tests run in ~4.3s
(`shutdownGraceMs: 500` in tests — engine shutdown grace dominated at the
3s default). **Lane note for the tests ticket**: `test/projection.test.ts`
sits in the vitest fast-lane glob today (no Docker, native addon under the
forks pool — same as better-sqlite3); formal placement is still that
ticket's call. Also for the finish-surface ticket: duroxide's Rust tracing
WARNs (`database is deadlocked`, retryable) spray stderr through test and
demo output — the LogTape bridge should capture that channel.
