---
type: task
blocked_by: [04, 05]
---
# Finish the surface: retry-parity implementation + LogTape bridge

## Question

Two closers once projection is hardened and the parity decision is in:

- Implement the retry-parity outcome in the queue layer's wrapper
  orchestration (whatever shape the grilling chose), including surfacing
  `lastError`-style detail on the `workflowRuns` row so failures are
  diagnosable from the collection alone.
- Route duroxide's Rust tracing through LogTape per ADR-0018: call
  `initTracing` (file or callback — check what 0.1.x actually offers), bridge
  into the `['super-line', '<pkg>']` category tree, and make sure the default
  is quiet (no stderr spam) with `enableSuperLineLogging()` lighting it up.

## Done when

A failing-then-retrying job shows the decided semantics in a test, and
duroxide's runtime logs appear under the super-line LogTape tree instead of
raw stderr.

## Answer
