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

Resolved 2026-08-07. Both closers implemented and tested
(`test/retry.test.ts`, 3 tests, ~3s).

**Retry parity (per the grilling's decision):**
- `PermanentJobError` exported from the kit (message + optional `code`);
  detection is **duck-typed by `name`** so plugin-queue's class works
  verbatim — both paths tested (exported class and a plain `Error` with
  `name` reassigned), each proven to run exactly **one** attempt against a
  `maxAttempts: 3` queue.
- Mechanism as decided: the queue worker wrapper catches the permanent throw
  and returns a `{ __slPermanent: { message, code? } }` envelope (a return
  never triggers engine retry); the `jobWrapper:` generator parses the
  yielded result and throws `permanent: <message>`, failing the
  orchestration immediately. Transient errors still ride the engine's
  `scheduleActivityWithRetry` (tested: throw-once worker completes with
  attempts = 2).
- `totalTimeoutMs` added to the queue definition (flat, validated,
  passed through to `RetryPolicy`); README gained the retry-divergence table
  (backoff/jitter/timeout semantics adopted from the engine, documented).
- **New normalization discovered by the test**: the engine stringifies a
  generator throw as `Error: <message>\n<stack>` — `normalizeError` keeps
  the first line minus the `Error: ` prefix before classification, so the
  row's `error` column carries the clean message for every failure, not just
  permanent ones (the `lastError`-style diagnosability ask).

**LogTape bridge (ADR-0018 shape):** 0.1.28's `initTracing` is **file-only**
(no callback sink), process-global, before-`runtime.start()`-only, and
silently no-ops if a subscriber exists. So the bridge: first kit in the
process calls `initTracing({ logFile: <tmp>/sl-workflows-trace-<pid>.log,
logFormat: 'json' })` — which itself silences the raw stderr spray — and a
module-global 500ms tail (unref'd timer, partial-line safe) forwards each
JSON line into `getLogger(['super-line', 'plugin-workflows', 'engine'])`
with levels mapped (WARN→warning etc.) and the message passed via a
`{message}` template placeholder so engine text with braces can't be
misinterpolated. Unconfigured LogTape drops the records → default quiet;
`enableSuperLineLogging()` lights them up. A host that installed its own
duroxide subscriber first wins silently (kit's tail stays dormant) — noted
in the README's Logging section. Verified both ways: the bridge test
captures engine records under the tree, and `scratch/demo2.mjs` output now
contains zero `duroxide::` console lines.

Root typecheck + lint green; the package's 7 tests (projection + retry) run
in ~8s total. `@logtape/logtape` joined dependencies at `^2.2.4` (server's
spec) and tsup externals.
