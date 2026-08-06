# pg_durable + Electric on one Postgres — verified coexistence

Resolution asset for the coexistence ticket. All claims verified live on
2026-08-07 against `ghcr.io/microsoft/pg_durable:0.2.5-pg17` (PostgreSQL 17.10,
amd64 under emulation) + `electricsql/electric` (untagged latest, same image the
self-tier tests use), both since torn down.

## Repro

```bash
docker network create pgd-net
docker run -d --name pg-durable-logical --platform linux/amd64 --network pgd-net \
  -p 54518:5432 -e POSTGRES_PASSWORD=pgdurable \
  ghcr.io/microsoft/pg_durable:0.2.5-pg17 postgres -c wal_level=logical
docker run -d --name electric-eval --network pgd-net -p 54520:3000 \
  -e DATABASE_URL='postgresql://postgres:pgdurable@pg-durable-logical:5432/postgres?sslmode=disable' \
  -e ELECTRIC_INSECURE=true electricsql/electric
```

Electric must target the database the extension lives in (`postgres` in the
Docker image; the `pg_durable.database` GUC can point a custom deployment at an
app database instead — the image hardcodes `postgres`, the extension doesn't).

## Verdicts, per the ticket's concerns

**Shared instance — YES, clean.** pg_durable boots and runs workflows normally
under `wal_level=logical` with Electric's replication slot
(`electric_slot_default`, pgoutput) active and streaming. A workflow started
while Electric was attached completed normally. No preload/GUC conflicts. Note
the connection budget: the worker held ~26 client backends (management 6 +
duroxide 10 + user 10) before Electric's own connections — size
`max_connections` accordingly.

**`df.*` watchability — YES.** `GET /v1/shape?table=df.instances&offset=-1`
returns 200 and a live handle. A workflow's full lifecycle arrived through the
shape log as row messages: `insert` (status `pending`, full row) → `update`
(status `running`, **partial diff**: only id/status/updated_at) → `update`
(status `completed` + completed_at). Partial diffs are the known Electric
behavior collections-pglite already compensates for with its full-row re-read.
Electric auto-configured the table: added it to `electric_publication_default`
and set **REPLICA IDENTITY FULL on an extension-owned table** (a benign but
notable mutation — an `ALTER EXTENSION UPDATE` that rebuilds the table would
drop it; Electric reconfigures on next shape access).

**Replication conflicts — NONE observed.** Slot active the whole session; the
BGW's own writes flow through it like any other traffic.

**RLS vs the shape — the snag is real but lands somewhere useful.** Electric
connects as superuser and, more fundamentally, **logical decoding ignores RLS**
— the shape carries *every* user's instances regardless of `submitted_by`. So a
`df.instances` shape must be consumed server-side and filtered by super-line's
own read policies before fan-out — which is precisely the server-authoritative
collections model. What does NOT work is treating pg RLS as the scoping layer
for a shape.

**Deletes — clean, and a known shape.** `df.instances` ↔ `df.nodes` form a
deferred FK cycle, so rows only delete in one transaction (which is how the
extension's retention reaper works); the shape then emits a **key-only,
prev-less `delete`** message — the exact delete shape the `self` tier's routing
already handles (prev-less deletes broadcast to all subs). Retention reaping
(default 30 days / 10k cap) will appear to a shape as periodic bulk deletes.

**Version envelope — a real bump.** The self-tier integration tests run
`postgres:16` (`collections-pglite.integration.test.ts`); pg_durable requires
PG 17/18. Electric-on-PG17 works (verified live, 17.10). So joint deployment
forces PG ≥ 17 — fine for Electric and (presumably) pgliteCollections, but
untested territory for the suite; nothing else in the self tier is known to be
version-sensitive.

**LISTEN/NOTIFY contradiction — resolved as doc drift.** Zero `LISTEN` in
`pg_stat_activity` across the worker's ~26 connections, matching duroxide-pg's
pure-polling source. The `max_duroxide_connections` GUC doc's "LISTEN/NOTIFY
dispatch" phrasing does not describe shipped behavior.

## What this means for "df.instances as a live collection"

The Electric layer is a proven YES — but collections-pglite today only syncs
its **own** `col_*` tables (created from contract schemas, fingerprint-gated).
Watching a foreign, extension-owned table whose shape drifts across versions
(0.2.5 has no `output` column; 0.2.6 will) is a new mechanism: either a
read-only external-table mode in collections-pglite (core/backends change), or
a plain server-side poller/projector that mirrors `df.instances` into a normal
super-line collection (no core change, eventual consistency at poll interval).
That choice belongs to the posture ticket.

Also settled by this ticket: the fog question of whether
collections-crdt-pglite / plugin-auth / plugin-chat need dedicated report
coverage — **no**; same-Postgres coexistence is clean, so they inherit only the
PG ≥ 17 version-envelope note.
