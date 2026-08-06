---
type: grilling
blocked_by: [03, 04, 05]
---
# Integration posture: adopt, interop, document, or pass — per surface

## Question

With the mapping table (03), the coexistence verdicts (04), and the duroxide-node
verdict (05) in hand, decide with Mert the posture per surface:

- (a) a pg_durable-backed option inside plugin-queue — the extension owns
  scheduling/leases/retries where the shared Postgres has it,
- (b) duroxide-pg as plugin-queue's durable core — extension-free, workers stay TS,
- (c) an interop contract fragment — start/cancel/observe `df.instances` as
  requests plus a live collection, Control Center view riding for free,
- (d) docs-only — a "pg_durable beside super-line" guide marking the boundary,
- (e) pass — note it in the report and move on,
- (f) a **separate durable-workflows plugin** on duroxide-node (multi-step,
  timers, signals, fan-out) — plugin-queue untouched; surfaced by the mapping
  ticket as where duroxide's value actually lands (its "S4"; see
  [queue-machinery-mapping.md](../assets/queue-machinery-mapping.md), which
  argues S1/d is free and true now, S3/b is a poor trade pre-1.0).

Also settle in the same conversation:

- Deployment-constraint tolerance: is "PG 17/18 + a preloaded extension + a
  superuser worker role" an acceptable ask, and for which users? (This gates (a)
  and (c) from first-class to opt-in.)
- Preview-status tolerance: does super-line take any dependency on a Microsoft
  preview, or does the report recommend a revisit date?
- Report coverage beyond the named three packages (the fog items:
  collections-crdt-pglite, auth/chat on the same Postgres).

## Done when

A posture recorded per surface, sharp enough that writing the report requires no
further decisions.

## Answer

Resolved 2026-08-07 in a live grilling with Mert. The posture, per surface:

1. **plugin-queue: untouched** — no engine swap, no extension backend. It stays
   the simple, zero-native-dep job engine.
2. **The integration vehicle is a new, alternative queue entirely backed by
   duroxide** (Mert's steer — none of the charted options; superseded them),
   built as **two layers**: a workflow kit mirroring duroxide's model
   (plain-async activities + generator orchestrations, super-line wiring) with
   a thin queue API on top.
3. **Built as a prototype on this map, before the report** — see the prototype
   ticket this resolution added; the report speaks from a working artifact.
4. **Observability = lifecycle projection**: the kit co-writes a `workflowRuns`
   collection at lifecycle transitions (live rows, CC view for free);
   step-level history stays behind duroxide's admin API via host-owned
   requests, plugin-queue-style.
5. **pg_durable extension seam: document only** — a "pg_durable beside
   super-line" how-to (coexistence facts, PG ≥ 17 envelope, the verified
   Electric-shape recipe for watching `df.instances`). The interop kit is
   recorded as proven-feasible, revisit on demand. No CC view for the
   extension.
6. **Graduation gate: consumer + fixes** — no npm publish until a concrete
   host needs it AND duroxide's open correctness bugs (locking/replay/
   shutdown) are closed; until then the kit stays in-repo, unpublished.
7. Report coverage (research-settled, confirmed): the three named packages;
   crdt-pglite/auth/chat inherit only the PG ≥ 17 note.
