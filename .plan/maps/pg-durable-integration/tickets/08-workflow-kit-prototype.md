---
type: prototype
blocked_by: [06]
---
# Prototype: duroxide-backed workflow kit + thin queue

## Question

Build the two-layer prototype the posture decision fixed — far enough to react
to, not to ship. Starting point: the executed sketch in
[duroxide-from-node.md](../assets/duroxide-from-node.md) (npm `duroxide` 0.1.28;
mind the `RetryPolicy.backoff` string-not-number typings bug).

Scope, per the posture resolution:

- **Layer 1 — workflow kit**: activities (plain async TS, `AbortSignal` shim
  over `isCancelled()`) + generator orchestrations, wired super-line-style
  (a kit with `contract`/`plugin` halves like queue()/auth()/chat()).
- **Layer 2 — thin queue API** on the kit: enqueue/get/cancel over a generic
  job-wrapper orchestration with a retry policy.
- **Lifecycle projection**: a `workflowRuns` collection co-written at
  queued/running/completed/failed (+ custom status), so runs are live rows;
  one host-owned request surfacing per-step history from the admin API.
- In-repo and unpublished (graduation gate: consumer + upstream fixes); pick a
  working name in the ticket. Demo: one single-step job AND one multi-step
  workflow (timer + fan-out or signal) surviving a process restart.

This is HITL — build rough, show Mert, iterate on reaction; record what the
build revealed (API friction, projection cost, restart behavior) for the
report.

## Done when

Mert has reacted to a running demo of both layers with live `workflowRuns`
rows, and the findings (what worked, what fought back, what the report should
say) are written down as an asset.

## Answer

Resolved 2026-08-07. Built at `.scratch/workflow-kit-prototype/` (`node demo.js`
crash-resume · `node demo2.js` cancel + signals), shown to Mert live; after two
requested iterations (cancellation, then signals) the verdict is **shape
confirmed**. Findings asset:
[workflow-kit-prototype-findings.md](../assets/workflow-kit-prototype-findings.md).

Highlights: the two-layer kit is ~170 lines with queue workers as verbatim
plugin-queue closures; SIGKILL mid-timer → restart → only the remaining
activity executes (checkpoint replay proven via event history); lifecycle
projection with custom-status step progress works via per-instance polling;
durable event queues deliver the approval pattern; cancellation lands as
`failed`+`canceled:` and must be classified back to `cancelled`. Six-item
work list for the real implementation recorded in the asset.
