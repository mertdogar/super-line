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
