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
