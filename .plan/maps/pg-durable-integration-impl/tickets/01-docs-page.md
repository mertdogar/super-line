---
type: task
blocked_by: []
---
# Write and publish the "pg_durable beside super-line" how-to

## Question

Write `docs/how-to/pg-durable-beside-super-line.md` (slug per existing how-to
conventions; note the digit-slug gotcha from past docs work) from the planning
map's verified findings: what pg_durable is and when it's the right tool vs.
app-tier queues/workflows; same-Postgres coexistence facts (worker connection
budget, `wal_level=logical`, PG ≥ 17 envelope); the working Electric-shape
recipe for watching `df.instances` (partial diffs, prev-less deletes, RLS does
NOT scope shapes — server policies must); and an honest boundary statement.
Source: `../pg-durable-integration/assets/electric-coexistence.md` +
`eval-instance.md` + `pg-durable-notes.md`. Published page: state behavior,
cite no ADRs/plans, and add it to the VitePress nav where the other how-tos
live.

## Done when

The page builds in `pnpm docs:build`, sits in the how-to nav, and a reader can
run the coexistence + shape recipe from it alone.

## Answer

Resolved 2026-08-07. `docs/how-to/pg-durable-beside-super-line.md` written and
registered in both the how-to sidebar (Collections group,
`docs/.vitepress/config.ts`) and the how-to index page. `pnpm docs:build`
green (79s); the rendered page confirmed in `dist/how-to/`.

Content: what pg_durable is (with the preview/replay-drain warning up front) ·
the boundary table vs plugin-queue (plus the Azure-only `df.http` egress fact
and the it's-just-SQL note for starting workflows from a handler) · the
shared-Postgres requirements list (PG ≥ 17, wal_level, preload, superuser
worker, ~26-connection headroom, CASCADE) · the Electric shape recipe for
`df.instances` with its four observed caveats (RLS doesn't scope the stream —
server policies must; table shape drifts per version; retention reaping = bulk
deletes; partial diffs + key-only deletes). No ADR/plan citations; house
style (VitePress containers, absolute links) throughout.
