---
type: task
blocked_by: [02]
---
# Scaffold the kit and absorb the prototype

## Question

Create the package per the identity decision: tsup/tsconfig/typedoc matching
sibling plugins, contract fragment via `defineContractPlugin` (the
`workflowRuns` schema + indexes — derive columns from what the prototype
projected: id, kind, name, status, customStatus, output, timestamps), server
plugin whose `setup(ctx)` owns the runtime, and the two layers ported from
`.scratch/workflow-kit-prototype/kit.js`: activities with the
AbortSignal-over-`isCancelled()` shim, generator orchestrations, per-queue
job-wrapper, `run`/`queue().enqueue`/`cancel`/`signal` (durable event queues,
not raw raiseEvent)/`recover`/`waitFor`/`history`. Provider wiring: host passes
a connected `PostgresProvider`/`SqliteProvider` (schema-per-deployment).
Wipe the prototype once absorbed (NOTES.md contract). Root typecheck must stay
green.

## Done when

`pnpm typecheck` and `pnpm lint` pass with the package in the workspace; the
prototype's demo scenarios re-run against the real kit (as a scratch script or
early test); `.scratch/workflow-kit-prototype/` is gone.

## Answer

Resolved 2026-08-07. `packages/plugin-workflows/` exists per the identity
decision and the prototype is absorbed and wiped.

**Package**: queue-style single entry — `package.json` (`private: true`,
0.0.0, `duroxide` pinned exactly `0.1.28`, zod dep, core/server as
peerDependencies `>=0.20.0/<1.0.0` + `>=0.21.0/<1.0.0` with `workspace:^`
dev mirrors), `tsup.config.ts` (esm+cjs, dts, `shims: true` — the CJS build
needs the `import.meta.url` shim for the lazy loader), `tsconfig.json`,
`typedoc.json` (present to match siblings but **not** registered in
`docs/typedoc.json` — a private package must not surface in the published API
reference), README with usage sketch + platform matrix.

**`src/index.ts`** (~370 lines): `workflowsContract()` via
`defineContractPlugin('workflows', ...)` declaring `workflowRuns`
(id · kind `workflow|job` · name · status (loose string until 04 normalizes)
· customStatus? · output? · createdAt/updatedAt; indexes
`[status, updatedAt]` + `[kind, name]`); `workflows({ provider, activities,
workflows, queues, pollIntervalMs?, cancelPollMs?, shutdownGraceMs? })`
returning the kit (`contract`/`plugin`/`run`/`queue(n).{enqueue,get,cancel}`/
`cancel`/`signal` (durable `enqueueEvent`)/`waitFor`/`history`/`recover`).
The plugin owns deny-all policies and `setup(ctx)` owns the duroxide
`Runtime` via plugin-queue's ready-promise pattern; teardown clears watchers
and `runtime.shutdown(grace)`. Activities get the AbortSignal-over-
`isCancelled()` shim; queues get the 6-line `jobWrapper:` generator with the
`backoff: 'exponential' as unknown as number` typings-bug cast. **duroxide is
loaded lazily inside `workflows()`** (`createRequire`, type-only imports), so
the native load failure rethrows with platform + gap named, per ticket 02.

Deviations from the prototype, all deliberate: **setup auto-recovers** (a
server boot IS the restart case; `recover()` stays public and idempotent);
recovery identifies kind/name from `getInstanceInfo().orchestrationName`
(`jobWrapper:` prefix ⇒ job) instead of the id-prefix hack; `history()` maps
the napi `event.kind` field (typed) rather than guessing key names.

**Verified**: root `pnpm typecheck` + `pnpm lint` green; both demo scenarios
re-ran against the real kit on a real server (loopback-less, memory
collections, `SqliteProvider` — no Docker): crash-resume (SIGKILL mid-timer →
restart → history shows both fan-out completions predate the crash, only
`aggregate` re-executed, total correct, projection re-armed by boot recovery)
and cancel + durable signal (approval completes with `decision` in output).
Demos live on as `scratch/{demo,demo2,worker}.mjs` in the package (marked
scratch, not shipped) — seed material for ticket 07's tests.

**Facts for later tickets**: (a) the linux-arm64 gap CLOSED upstream —
`duroxide-linux-arm64-gnu@0.1.28` is on npm; README states the full matrix
(darwin x64/arm64, linux x64/arm64 glibc, win x64; musl still unsupported).
(b) Cancellation surfaces as `failed` + `canceled: <reason>` and terminal
rows keep their last customStatus — both confirmed live, both ticket 04's
normalization work. (c) Two runtimes on one SQLite file emit retryable
"database locked" WARNs on Rust tracing/stderr — ticket 06's LogTape bridge
should capture this channel.
