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
