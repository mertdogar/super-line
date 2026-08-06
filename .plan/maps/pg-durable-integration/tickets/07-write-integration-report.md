---
type: task
blocked_by: [06, 08]
---
# Write the integration report — spec.md

## Question

Produce the destination artifact: `.plan/maps/pg-durable-integration/spec.md`.
Structure: a framework primer (from the deep-dive and the live instance) → per-
surface analysis (queue-machinery mapping, Electric coexistence, duroxide-from-
Node) → the decided posture per surface with its reasoning → what building the
workflow-kit prototype revealed → recommended next steps sized for a
`pg-durable-integration-impl` map. Repo-internal: citing ADRs and plans is
fine.

## Done when

`spec.md` stands alone — a reader who never opened this map's tickets understands
what pg_durable is, how it fits (and doesn't) each surface, what was decided and
why, and what an implementation effort would pick up first.

## Answer

Resolved 2026-08-07. [spec.md](../spec.md) is written — the map's destination.

Seven sections: summary with the per-surface verdict table · what pg_durable
actually is (three layers; the extension seen from the running instance; the
documentation drift) · per-surface analysis (plugin-queue, the self tier, core)
· the decided posture with its reasoning · what the prototype revealed
(including the six-item friction list) · seven recommended next steps in
dependency order for a `pg-durable-integration-impl` map · an evidence index
mapping every claim to its asset, separating what was verified live from what
was sourced from upstream docs.

Headline: super-line takes no dependency on the pg_durable extension and no
published dependency on duroxide; the integration is a new, prototyped,
unpublished durable-workflows kit built beside plugin-queue rather than
retrofitted into it, plus one documentation page for the extension.

**The map is complete** — no tickets remain.
