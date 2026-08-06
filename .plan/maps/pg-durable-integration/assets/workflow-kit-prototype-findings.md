# Workflow-kit prototype — findings

Resolution asset for the prototype ticket. The prototype lives at
`.scratch/workflow-kit-prototype/` (throwaway; `node demo.js` for crash-resume,
`node demo2.js` for cancel + signals; Postgres from the `pg-durable-eval`
container). Mert reacted live on 2026-08-07: **shape confirmed**, after two
requested iterations (cancellation, signals).

## What the demos proved

- **The two-layer shape holds.** ~170 lines of kit code deliver both layers:
  `workflows({ activities, workflows, queues })` → `kit.run()` /
  `kit.queue(n).enqueue()` / `cancel` / `signal` / `recover` / `waitFor` /
  `history`. Queue workers are **verbatim plugin-queue closures**
  (`(input, { signal })`) — the wrapper generator per queue is 6 lines.
- **Crash-resume is real**: fan-out completed → SIGKILL mid-durable-timer →
  restart → timer fired and **only the remaining activity executed**; the
  fan-out results replayed from checkpoints (visible in the event history:
  their `ActivityCompleted` events predate the crash).
- **Lifecycle projection works and is cheap**: one polling watcher per live
  instance co-writing `starting → running (customStatus) → completed/failed`
  rows; custom status gives step-level progress for free
  (`fanning-out`/`waiting-timer`/`aggregating`, `awaiting-approval`).
- **Cancellation**: terminal ~1s after `cancel()`; in-flight activity's abort
  shim fires (cooperative cleanup) though its return value is discarded —
  orchestration goes terminal immediately.
- **Signals**: durable event queues (`enqueueEvent`/`dequeueEvent`) park and
  resume a workflow cleanly — the approval/human-in-the-loop pattern. (Raw
  `raiseEvent`/`waitForEvent` drops pre-subscription events; the kit should
  default to queues.)
- Crash-orphaned work items **self-heal** on next boot (runtime acks stale
  batches for terminal instances).

## What the real kit must own (the frictions found)

1. **No lifecycle hook in duroxide-node** — projection is per-instance polling
   (`getStatus` loop). `getStatus` transiently returns `notfound` before an
   instance's first turn; treat as still-starting, not missing.
2. **Recovery must read existing rows**: `recover()` lists non-terminal
   instances and re-arms watchers; run metadata (name/kind/input) must come
   from the durable collection (the in-memory shim lost it — pgliteCollections
   won't).
3. **Normalization layer**: duroxide output is double-JSON-encoded; statuses
   are capitalized; customStatus survives past terminal states. All three need
   normalizing before rows are written.
4. **No distinct `cancelled` status** — cancellation lands as `failed` +
   error `canceled: <reason>`. The kit must classify that into `cancelled` for
   status parity with plugin-queue.
5. **Tracing noise**: Rust `tracing` writes to stderr by default — the real
   kit should route it (`initTracing`) through LogTape per ADR-0018.
6. Carried from earlier research: `RetryPolicy.backoff` typings bug (string,
   not number); `timeoutMs` required; timeouts never retried; no jitter or
   permanent-error class — the queue layer reimplements those if parity
   matters.

## What this changes for the report

Nothing in the posture — it confirms it. The report can now state, from a
running artifact: the kit is small (~170 lines for the skeleton), the worker
contract transfers verbatim, restart/cancel/signal semantics are demonstrated,
and the projection cost is one polling watcher per live run plus a
normalization layer — with the six items above as the known work list for a
real implementation in the `-impl` map.
