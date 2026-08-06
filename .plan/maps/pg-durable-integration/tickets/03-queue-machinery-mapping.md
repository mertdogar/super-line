---
type: research
blocked_by: [01]
---
# Map plugin-queue's durability machinery onto pg_durable

## Question

plugin-queue's durability today (`packages/plugin-queue/src/index.ts`): deny-all
`queueJobs` / `queueSchedules` / `queueSlots` collections on the shared store;
slot claims with `leaseExpiresAt`; a `pollIntervalMs` tick plus a `wake` cluster
channel for hints; five-field cron via cron-parser; retries/backoff;
`PermanentJobError`; at-least-once TS workers honoring `AbortSignal` (ADR-0023:
unbound queues are skipped, not failed). With shared Postgres via
`pgliteCollections` this is already cluster-correct.

For each mechanism, which of these holds when the shared Postgres has pg_durable?

- pg_durable **owns it** (cron/timers, checkpointed retries, instance status —
  candidates for deletion on our side),
- it **interops** (e.g. `df.http()` calling back into a super-line server request;
  a durable function enqueuing super-line jobs or vice versa),
- it **can't express it** (TS worker closures foremost — a pg_durable step is SQL
  or HTTP, full stop).

From that table, name the honest candidate shapes: "pg_durable replaces the
scheduler/lease layer", "df.http() bridges to super-line workers", "duroxide-pg
from Node replaces the polling core" (ticket 05's subject), or "no fit —
complementary tools, document the boundary".

## Done when

A per-mechanism mapping table (owns / interops / can't express) plus named
candidate shapes, ready to put in front of Mert in the posture grilling.

## Answer

Resolved 2026-08-07. The full per-mechanism table (owns / interops / can't
express, both seams) and four named candidate shapes are in
[queue-machinery-mapping.md](../assets/queue-machinery-mapping.md), built from a
full read of `packages/plugin-queue/src/index.ts` plus duroxide's retry-policy
doc (closing the deep-dive's retry-defaults gap — with a correction: duroxide
activities do NOT auto-retry; retry is opt-in `RetryPolicy`, and timeouts are
never retried, unlike plugin-queue where a timeout burns an attempt).

The honest headline: **for single-step jobs — what plugin-queue models —
duroxide's engine buys almost nothing super-line doesn't already have** (and
loses priority ordering, jitter, permanent-error short-circuit, per-queue
concurrency, and jobs-as-live-collections), while costing a Preview-grade napi
dependency and an observability projection layer. Its real value (checkpointed
multi-step jobs, durable timers, signals, fan-out) begins exactly where jobs
stop being single-step. The pg_durable extension itself cannot run our workers
at all (SQL/HTTP steps only; the HTTP bridge is Azure-only in released builds).

Candidate shapes for the posture grilling: **S1** document-the-boundary (free,
true today) · **S2** interop surface for extension hosts (rides on the
coexistence verdict) · **S3** swap plugin-queue's engine → poor trade pre-1.0 ·
**S4** a *separate* durable-workflows plugin on duroxide-node, plugin-queue
untouched — where duroxide's value actually lands. The grilling ticket's option
list has been updated to include S4.
