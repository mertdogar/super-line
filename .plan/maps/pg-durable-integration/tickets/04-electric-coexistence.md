---
type: research
blocked_by: [01, 02]
---
# Coexistence with the self tier: pg_durable + Electric on one Postgres

## Question

`collections-pglite` assumes a central Postgres it shares with Electric
(`wal_level=logical`, one shape + `live.changes` per table, construction DDL
serialized via `pg_advisory_xact_lock`). A `self`-tier deployment that also wants
pg_durable puts both on the same instance. Verify, empirically on the ticket-02
instance where possible:

- Can Electric and the pg_durable extension share one Postgres — logical
  replication slots vs. the background worker, any preload/GUC conflicts, and the
  "extension lives in the `postgres` database" constraint vs. where the app
  database lives?
- Can `df.instances` be watched through an Electric shape, so durable-function
  status becomes a live super-line collection (the interop posture's foundation)?
  RLS on `df.*` vs. Electric's replication role is the suspected snag.
- Version envelope: pg_durable is PG 17/18 only — what do the self tier and its
  tests currently assume, and does anything break at PG 17?

## Done when

A verified yes/no per concern (shared instance, replication conflicts, `df.*`
watchability, version envelope) with repro notes in `assets/`.

## Answer

Resolved 2026-08-07, all concerns verified live (repro + evidence in
[electric-coexistence.md](../assets/electric-coexistence.md)):

- **Shared instance: YES, clean.** pg_durable runs workflows normally under
  `wal_level=logical` with Electric's slot active; no conflicts. Budget note:
  the worker alone holds ~26 client backends.
- **`df.instances` via an Electric shape: YES.** Full lifecycle observed as row
  messages (insert pending → partial-diff updates → completed). Partial diffs
  and key-only prev-less deletes are exactly the Electric behaviors the `self`
  tier already compensates for. Electric sets REPLICA IDENTITY FULL on the
  extension-owned table (benign, noted).
- **RLS snag confirmed but lands well**: logical decoding ignores RLS, so a
  shape carries every user's instances — scoping must come from super-line's
  server-side read policies, which is the collections model anyway.
- **Version envelope: joint deployment forces PG ≥ 17** (self-tier tests
  currently run postgres:16; Electric-on-17 verified live).
- **LISTEN/NOTIFY contradiction resolved as doc drift** — pure polling
  confirmed live.
- Caveat for the posture ticket: collections-pglite only syncs its own `col_*`
  tables today, so "df.instances as a live collection" needs either a read-only
  external-table mode (core change) or a plain poller/projector into a normal
  collection (no core change).

Also settles the fog question on crdt-pglite/auth/chat report coverage: none
needed beyond the PG ≥ 17 note.
