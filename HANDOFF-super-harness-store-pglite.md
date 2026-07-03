# Handoff — adopting `@super-line/store-pglite` as super-harness's durable tree store

**Audience:** super-line team (for opinion) + the next agent that implements the agreed changes.
**Owner context:** Mert owns both repos. tomorrow-kits is **multi-node with Postgres + Electric already in the stack**, so the self-clustering store-pglite is the *intended* durable backend — this is decided, not open.

## TL;DR

super-harness currently ships two **hand-rolled** relay LWW store backends (`pgStoreServer`, `libsqlStoreServer`) in `packages/server/src/stores.ts` (committed as `7b02dbb`). We want to replace the postgres path with the blessed `@super-line/store-pglite` (central Postgres + Electric-synced PGlite replica, `clustering: 'self'`).

The good news after tracing both codebases: **store-pglite already supports everything super-harness needs at runtime** — the "blocker" I first hit (`pgliteStoreServer` has no `open()`) is *not* a real blocker, because the super-line server handle exposes `write(id, data)` (= `store.apply({id, update, origin})`) which store-pglite implements. super-harness's tree sink only ever whole-doc-writes.

So the reconciliation is mostly **super-harness-side** (swap the sink's co-writer `open().set()` → `handle.write()`), plus a small set of **super-line design questions** that genuinely need the team's opinion — chiefly the write-amplification of streaming model tokens through a self-clustering (central-PG + Electric) store.

## What store-pglite actually is (verified in source)

`super-line/packages/store-pglite/src/index.ts` + its test:

- `clustering: 'self'`, `model: 'lww'`. Central Postgres (`postgres(pgUrl)`) is the write/strong-read/ACL source of truth. Each node runs an **in-memory PGlite replica fed by Electric** (`electricUrl` → `syncShapeToTable`).
- `onChange`/`onDelete` fire from the **replica's `live.changes` feed**, NOT the write path. A write round-trips central PG → Electric → every node's replica → `onChange`. The `origin` column carries echo-break through the round-trip.
- Surface: `read / create / apply / setAccess / delete / list / onChange / onDelete / close`. **No `open()` co-writer.**
- Still `0.1.0`, **unpublished** to npm (local workspace only). Anything that consumes it needs a publish (or workspace link).

## What super-harness needs from a store backend (exhaustively traced)

Server handle calls in `super-harness/packages/server/src/serve.ts`: `create`, `read`, `write` (via the co-writer today), `delete`, `grant` (= read + `setAccess`), `list`, plus `onChange`/`onDelete` fan-out. The `join` handler uses create/read/grant; the `thread_deleted` purge uses read/delete.

Sink co-writer (`super-harness/packages/server/src/sink.ts`): uses **only** `ns.open(id, {origin:'harness'}).set(fullDoc)` — never `getSnapshot`/`update`/`delete(path)`/`subscribe`. The projector always hands it a complete node/thread doc.

**Every one of these is already supported by store-pglite** — except the sink's use of `open()`, which is directly replaceable by the handle's `write(id, data)` (`super-line/packages/server/src/index.ts` ~L1215: `write` → `store.apply({id, update:data, origin: SERVER_ORIGIN})`). store-pglite implements `apply()`, so `write()` works on it unchanged.

## The one super-harness-side change (no super-line change required for the write path)

In `super-harness/packages/server/src/sink.ts`, replace the co-writer pattern:

```
// now:  const r = ns.open(id, {origin:'harness'}); r.set(doc)      // repeated per event
// to:   await ns.write(id, doc)                                     // apply() under the hood
```

Drops the cached-replica bookkeeping (`nodeReplicas`/`nodePending`/`threadReplica`) — `write()` is stateless. `StoreNs` in sink.ts loses `open` and gains `write(id, data): Promise<void>`. `serve.ts` `backend()` gains a `{ type: 'pglite', pgUrl, electricUrl, table }` variant that returns `pgliteStoreServer(...)`; existing sqlite/memory/libsql/postgres variants stay.

This is small and self-contained; the next agent can do it once the super-line questions below are resolved.

## Super-line questions / proposed improvements (the "get their opinion" part)

### 1. Write amplification: streaming tokens through a self-clustering store — the big one

super-harness makes the durable tree the single source of truth: the sink writes the **whole** node doc on **every** stream event (text-delta, tool-call, tool-result). That's tens–hundreds of whole-doc writes per turn, and each grows as text accumulates.

- On a **relay** store (sqlite/memory) these are cheap in-process writes with synchronous `onChange`.
- On **store-pglite** each write is a **central-PG UPDATE over the network**, then Electric diffs the shape and streams it to every node's replica before `onChange`/WS fan-out fires. So: (a) central-PG write load ~= token rate × active turns × nodes, (b) Electric shape-churn, (c) visible streaming latency = PG-write + Electric-poll + replica + onChange + WS, instead of in-process.

**Questions for the team:**
- Is putting a token-granularity stream through the durable self-clustering store an acceptable workload, or should high-frequency streaming ride **events** (ephemeral, room broadcast) with the **store** used only for checkpoints/final docs? (This is the classic super-line "events for ephemeral, stores for durable state" split — super-harness currently ignores it and stores *everything*.)
- If we keep it in the store, where should **coalescing/debounce** live — inside a store-pglite co-writer, or in super-harness's sink (flush the growing doc at most every N ms)?
- What is Electric's realistic added streaming latency at our poll/stream config?

### 2. `open()` co-writer parity on store-pglite (optional but general)

super-harness can avoid `open()` via `write()`, but every other backend (memory, sqlite, and my relay pg/libsql) provides the reactive co-writer. A store-pglite `open()` would:
- `set/update/delete(path)` → central-PG write with the handle's origin; `getSnapshot()` from a **local cache** seeded by a central `read()` on open (the replica lags, so it can't be the snapshot source); `subscribe()` filters `onChange` by id.
- Inherit the async round-trip: a co-writer's own `getSnapshot()` reflects its last local write immediately (cache), but *other* writers' changes arrive only after Electric.

**Question:** worth adding for backend parity / other consumers, or intentionally omit on self-clustering stores and steer everyone to `write()`/`apply()`? If added, should `write(id, data, {origin})` also take an origin (today it's hard-coded `SERVER_ORIGIN`; super-harness tags co-writes `'harness'` for inspector attribution)?

### 3. Subscribe-time snapshot vs live-delta ordering (known race, revalidate under self-clustering)

super-harness carries a standing note (its CLAUDE.md + a memory): a store subscribe's **initial snapshot can arrive after live co-writer deltas and clobber newer client state** — fix belongs in super-line, super-harness keys its `wire.test.ts` assertions off the event stream to dodge it. Under store-pglite the catch-up is a **strong central read** while live deltas come via **Electric → onChange**; the client-store `seed` vs `applyRemote` ordering in core is the same code path.

**Question:** does the self-clustering topology change (fix? worsen?) this race, and is the resolution the client-store seed/applyRemote ordering in core? We'd like it fixed upstream rather than worked around again.

### 4. Operational / packaging

- **Publish** `@super-line/store-pglite` (currently `0.1.0`, unpublished) so super-harness can depend on it. Confirm the intended `pgUrl`/`electricUrl` config surface is stable.
- Confirm the **idempotent-create** contract super-harness relies on: sink does `create().catch(()=>{})` then write; store-pglite `create()` is `INSERT … ON CONFLICT DO NOTHING` → `CONFLICT` throw (swallowed). Good, just confirm it's the blessed pattern.
- `thread_deleted` purge (super-harness `7b02dbb`) deletes node + thread docs via `handle.delete()`. On a self-clustering store this must fan `onDelete` → `sdel` to clients with the resource open. Confirm the self-store delete-fan path reaches remote-node clients (central DELETE → Electric delete → replica `live.changes` DELETE → `onDelete`).

## References (don't re-derive)

- super-harness store backends + `ServeConfig.storage` union + `thread_deleted` purge: commit `7b02dbb`; files `packages/server/src/{stores.ts,serve.ts,sink.ts}`, tests `stores.test.ts` (real libsql + PGlite), `wire.test.ts`.
- store-pglite: `super-line/packages/store-pglite/src/index.ts`, `test/store-pglite.test.ts`, `examples/store-pglite/`.
- super-line server store handle (`write`/`open`/`grant`/`delete`): `super-line/packages/server/src/index.ts` ~L1215–1305; `open()` UNSUPPORTED throw at ~L1263.
- super-harness architecture / the two-projection split (Mastra memory = agent truth, super-line Stores = client-render truth): `super-harness/packages/server/CLAUDE.md`, `examples/web/CLAUDE.md`.

## Suggested skills for the next session

- **`super-line`** (project skill) — Store/ServerStore/co-writer/clustering semantics; read before touching store or contract code.
- **`grill-me`** — if the team pushes back and the design forks again (events-vs-store split is the likely debate).
- **`mastra`** — only if the coexistence-with-`PostgresStore` detail (sharing the same Postgres/connection) comes back up.

## State of the working tree

Clean at `7b02dbb` (the relay libsql/postgres backends + deleteThread fix are committed and green: typecheck, 64 tests, lint). Demo servers may still be running: web-server :4111 (inspector on), vite :5173. **No** store-pglite work started yet — this handoff precedes it, pending the team's answers to §1–§4.
