---
type: grilling
blocked_by: []
---
# Retry-parity: reimplement plugin-queue semantics or document divergence?

## Question

The queue layer's retry story diverges from plugin-queue's
(`../pg-durable-integration/assets/queue-machinery-mapping.md`): duroxide's
`RetryPolicy` has no jitter, no permanent-error class (any thrown error
retries), and never retries timeouts, while plugin-queue has jitter 0.2,
`PermanentJobError` short-circuit, and timeout-counts-as-attempt. Decide with
Mert: (a) reimplement parity in the kit's queue layer — a hand-built retry
loop in the wrapper orchestration (duroxide's own retry helpers are just that,
so this is idiomatic, ~20 lines, and restores all three), (b) adopt duroxide's
semantics as-is and document the divergence, or (c) partial — e.g. permanent
errors matter (workers already throw `PermanentJobError`-style), jitter/timeout
semantics don't. Also settle: does the queue layer accept plugin-queue's
`BackoffConfig` shape for familiarity, or duroxide's `RetryPolicy` shape for
transparency?

## Done when

The choice and the config-shape decision are recorded, sharp enough for the
finish-surface ticket to implement without further questions.

## Answer

Resolved 2026-08-07 with Mert: **(c) partial — permanent errors only**, and
**the engine's shape, flat**.

1. **Permanent-error short-circuit comes back; jitter and timeout-retry do
   not.** Mechanism (no hand retry loop): the queue's activity wrapper
   catches a thrown error whose `name === 'PermanentJobError'` (duck-typed —
   the kit does not import plugin-queue) and **returns a marker envelope**
   instead of rethrowing (e.g. `{ __slPermanent: { message, code? } }`).
   A returned value never triggers the engine's retry; the wrapper generator
   inspects the yielded result and, on marker, throws
   `permanent: <message>` — failing the orchestration immediately, first
   attempt. Normalization classifies that error into the row (status
   `failed`, `error` = message) the same way `canceled:` maps to
   `cancelled`. The kit exports its own `PermanentJobError` class for
   convenience, but duck-typing keeps plugin-queue workers portable verbatim.
2. **Jitter / timeout-counts-as-attempt: adopt engine semantics and document
   the divergence** in the README's boundary section (no jitter — the engine
   owns scheduling; a timed-out attempt is terminal, never retried). Rationale:
   both would require hand-built, replay-sensitive generator machinery
   (deterministic jitter via `newGuid`, `maxAttempts:1` nesting) where every
   future edit is an in-flight-upgrade trap; duroxide is preview and may grow
   these upstream.
3. **Config shape: engine shape, flat** — exactly what the scaffold has:
   `{ worker, maxAttempts?, timeoutMs? }` on the queue definition, plus
   optional `totalTimeoutMs` passed through to `RetryPolicy`. No nested
   `BackoffConfig`: duroxide's `RetryPolicy` has no delayMs/maxDelayMs/jitter
   fields, so plugin-queue's shape would promise knobs that cannot be
   honored.

The finish-surface ticket implements: the envelope + classification, the
`PermanentJobError` export, `totalTimeoutMs` pass-through, and the README
divergence table.
