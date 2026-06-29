# PLAN — `@super-line/store-sync-pglite` (CRDT over Postgres + Electric) + `examples/ai-canvas-pglite`

A **genuine CRDT** server Store whose cross-node sync is owned by the store itself (ElectricSQL),
**not** super-line's adapter — the CRDT sibling of [`store-pglite`](./PLAN-store-pglite.md). Where
`store-pglite` is `clustering:'self'` + `model:'lww'` (single-row, full-`data` replace), this is
`clustering:'self'` + `model:'crdt'`: an **append-only Yjs op-log** in central Postgres that Electric
ships to every node, each folding the deltas into an in-memory `StoreValue` (super-store's Yjs engine).
INSERTs never conflict → no clobber → true convergence (Yjs `applyUpdate` is order-independent).

Decided in a `/grill-me` session on 2026-06-29. The driving requirement: **showcase CRDT** while
**keeping store-pglite's "Electric is the bus, no adapter" thesis**. The two are reconcilable only via
an op-log (single-row LWW + Electric cannot merge — Electric ships whole rows and concurrent writers
clobber). The win that falls out: an in-memory Yjs doc makes `open()`/`ServerReplica` feasible — the
exact feature `store-pglite` deferred (its `getSnapshot` would have to hit the async PG driver; here it
reads the live in-memory doc synchronously).

---

## Why this is mostly reuse, not new mechanism

- **No core change.** `packages/server/src/index.ts:1029-1053` (the `self` branch added for store-pglite)
  fans `change.update` to local members and branches **only** on `store.clustering`, never `store.model`.
  A `self` + `crdt` store works as-is: `onChange` → `sch` to local members; `onDelete` → `sdel`;
  `storeApi.delete` skips the adapter. Model-agnostic.
- **Client reused verbatim.** The client half is `syncStoreClient` from `@super-line/store-sync` — it
  already speaks base64 Yjs deltas and `seed`s from `b64(encodeState())`. The new package ships **no
  client half** (like store-pglite ships none).
- **Engines reused.** Yjs doc management = `@super-store/store` (`StoreValue`: `encodeState`/`applyUpdate`/
  `onUpdate`/`getSnapshot`/`set`/`update`/`subscribe`). Electric scaffolding = copied from store-pglite
  (`PGlite` + `live` + `electricSync` + `syncShapeToTable` + `live.changes`). `removeAtPath` from core.
- **Example reused verbatim.** `ai-canvas`'s `scene.ts` / `agent.ts` / `contract.ts` / `App.tsx` /
  `main.tsx` / `styles.css` / `index.html` / `vite.config.ts` / `Caddyfile` copy over unchanged.

So the net new surface is: **one server-side package + one example whose `server.ts`, `docker-compose.yml`,
`package.json` differ from `ai-canvas` (plus a one-line SPA node-switch).**

---

## Topology

```
   writes = INSERT a Yjs delta row;  strong ACL reads (postgres.js)
   node A ───────────────────────────────────────────────┐
   node B ───────────────────────────────────────────┐   ▼
                                                      ▼   central POSTGRES (source of truth)
   each node ALSO runs:                                   │ logical replication
     in-memory PGlite { live, electricSync }     ◀───[ ELECTRIC ]  HTTP /v1/shape (one-way → PGlite)
        syncShapeToTable('resources') + ('updates')
        live.changes('updates') ─► ydoc.applyUpdate ─► onChange (delta+origin) ─► LOCAL conns
        live.changes('resources') ─► onDelete ─► LOCAL conns
   in-memory StoreValue (Yjs) per resource = folded op-log = the live state served to read()/open()
```

## Central schema (two Electric-shipped tables)

```sql
CREATE TABLE resources (
  id     text PRIMARY KEY,        -- existence + strong ACL
  access jsonb NOT NULL,
  origin text                     -- (kept for parity; ACL/existence live here)
);
CREATE TABLE updates (
  seq    bigserial PRIMARY KEY,   -- append-only Yjs op-log; ordering/dedup/compaction key
  res_id text NOT NULL,
  update text NOT NULL,           -- base64 Yjs delta (Electric ships text fine)
  origin text                     -- echo-break origin, carried through the Electric round-trip
);
```

Both tables are published (logical replication) and synced to each node's in-memory PGlite replica.

---

## Decisions (resolved in grilling)

| # | Decision | Choice |
|---|----------|--------|
| Showcase | what it proves | **genuine CRDT** (Yjs merge, merge-safe concurrency, `ServerReplica` co-writer) **over Postgres+Electric**, multi-node — the differentiator vs single-node `ai-canvas` |
| Why not store-pglite as-is | LWW vs CRDT | LWW single-row + Electric **clobbers** concurrent writers; CRDT needs commutative delta merge → **op-log** |
| Transport | cross-node | **append-only `updates` op-log**, Electric-shipped, folded per node. No adapter for the store. |
| Engine | CRDT doc | reuse **`@super-store/store`** `StoreValue` (Yjs) |
| Materialization | in-memory docs | **always-folded**: every node folds the whole op-log into one `StoreValue`/resource (lazy-create on first row; boot rehydrates via Electric replay). Ceiling: all docs in RAM (`ponytail:` lazy+LRU later). |
| `read()` state | catch-up | `b64(localYdoc.encodeState())` — **eventually-consistent** (client merges live deltas, CRDT-converges) |
| `read()` ACL | authorization | **strong, from central `resources`** (postgres.js) — no replica-lag denial |
| `apply` / replica writes | local write | integrate into local ydoc **+** INSERT delta row to `updates` (idempotent Electric echo) |
| `onChange` source | fan-out feed | `live.changes('updates')` (carries `origin` for echo-break) → core fans local |
| `onDelete` | resource delete | `live.changes('resources')` DELETE → core fans `sdel` local |
| `open()`/ServerReplica | server co-writer | **implemented** (in-memory ydoc → sync `getSnapshot`) — resolves store-pglite's deferral; the agent needs it |
| delete semantics | shape vs resource | shape-level `delete(['shapes',id])` = a Yjs delta = an `updates` row; resource-level `delete(id)` = `resources` row delete → `onDelete` |
| Core change | server | **none** (self branch is model-agnostic) |
| Client half | reactive replica | **reuse `syncStoreClient`** (store-sync) — package ships none |
| Package | naming | **`@super-line/store-sync-pglite`**, factory **`syncPgliteStoreServer({ pgUrl, electricUrl?, db?, resolveOptions? })`** |
| Compaction | op-log GC | **deferred** (`ponytail:` comment; Yjs state-baseline replace when it bites) |
| Example | deliverable | **`examples/ai-canvas-pglite`** — ai-canvas re-clustered: SPA verbatim, new `server.ts` + compose; `?node=` switch for two-windows-two-nodes |

---

## ServerStore surface (`clustering:'self'`, `model:'crdt'`)

| method | behaviour |
|--------|-----------|
| `read(id)` | `{ id, data: b64(ydoc.encodeState()), accessRules: <strong from central `resources`> }`; `undefined` if no central row |
| `create(id,data,access)` | INSERT `resources` row (`ON CONFLICT`→`CONFLICT`); seed = encode `data` as a Yjs update → INSERT first `updates` row |
| `apply(change)` | `change.update` is a base64 delta → `ydoc.applyUpdate` locally **and** INSERT `updates`(res_id,update,origin) |
| `open(id,{origin})` | `ServerReplica` over the in-memory ydoc: sync `getSnapshot`; `set`/`update`/`delete(path)` mutate ydoc (origin-stamped) + INSERT the captured delta; `subscribe`; `close` |
| `setAccess` / `delete` | UPDATE / DELETE central `resources` (delete → `onDelete`) |
| `onChange(cb)` | fed by `live.changes('updates')`: fold → `cb({ id: res_id, update, origin })` |
| `onDelete(cb)` | fed by `live.changes('resources')` DELETE → `cb(id)` |
| `close()` | unsubscribe both live feeds + both shapes; `pglite.close()` (if owned); `sql.end()` |

---

## Build order (TDD, from root)

1. **package skeleton** `packages/store-sync-pglite` (package.json, tsconfig, tsup) — deps above.
2. **central CRUD + op-log** via postgres.js against a `PGLiteSocketServer` stand-in (plain SQL works;
   only NOTIFY didn't — proven in store-pglite): `create`/`read`/`apply`(INSERT delta)/`setAccess`/
   `delete`/`list`. Assert two concurrent `apply`s both land as rows (no clobber).
3. **fold mapping**: write directly into the local `updates`/`resources` tables (simulating an Electric
   push) and assert `onChange`(delta+origin) / `onDelete`; assert `read()` returns the folded
   `encodeState`; assert idempotent re-apply of an own row emits nothing new.
4. **`open()`/ServerReplica**: `getSnapshot`/`update`/`delete(path)` mutate the ydoc + emit a delta row;
   `getSnapshot` is synchronous and reflects the agent's own write immediately.
5. **wire real Electric** (`syncShapeToTable` for both tables) — covered by the example, not unit tests.
6. **example** `examples/ai-canvas-pglite`: copy ai-canvas SPA verbatim; new `server.ts` (per-node,
   `syncPgliteStoreServer` + `agentEdit` `ServerReplica` + libp2p-mDNS coordination plane for CC +
   per-conn grant); reuse store-pglite's docker-compose (postgres + electric + node-1 + node-2 + web +
   CC); `?node=` switch in the SPA. **Browser-verify** two windows on two nodes CRDT-converge through
   Electric; Control Center shows the whole cluster.

Versions: new package `0.1.0`. No core/server/client bump (no change). **Ask before publish.**

---

## Status (as-built, 2026-06-29)

**BUILT + verified end-to-end; merged to `main` (= `origin/main`) and published** (`ef0c922`
`feat(store-sync-pglite): CRDT store over Postgres + Electric op-log`; release `1d979b7`).
`@super-line/store-sync-pglite` now lives in `packages/store-sync-pglite`.

- `@super-line/store-sync-pglite` `0.1.0`: `syncPgliteStoreServer({ pgUrl, electricUrl?, table?, db?, resolveOptions? })`
  — two tables (`<table>` meta + `<table>_updates` Yjs op-log), per-node in-memory super-store docs folded from
  the op-log via `live.changes`, `open()`/`ServerReplica` over the live doc, strong ACL from central. **No core
  change** (the `self` branch is model-agnostic). Client = unchanged `syncStoreClient`.
- `examples/ai-canvas-pglite`: ai-canvas SPA/scene/agent/contract reused verbatim; new `server.ts` (CRDT store +
  libp2p-mDNS coordination plane + `agentEdit` ServerReplica) + cluster `docker-compose` + `?node=` switch.
- Tests: 5 package tests (central CRUD + op-log, fold mapping, `open()`); full suite green; typecheck/lint/build clean.
- **Docker end-to-end verified**: clean 2-node boot; a client on node-1 adds `S_alice`, a client on node-2 adds
  `S_bob` → **both shapes converge on both nodes** through the Electric op-log (CRDT merge, no clobber, no adapter);
  Control Center topology shows both nodes.

**Post-build: compaction + materialized snapshot (requested 2026-06-29).** The `resources` table holds only
`id/access/origin/data` — the board *state* lives in the op-log, not a materialized row (that's the CRDT design;
a per-write `data` UPDATE would reintroduce LWW-clobber). Added opt-in **compaction** (`compact?: {everyNUpdates,
debounceMs}`, on by default): a debounced single pass folds the op-log → writes a baseline row → trims superseded
rows → materializes the folded board into `<table>.data` (SQL-queryable). No cross-node lock — concurrent
compaction is benign (idempotent baselines, commutative trims). Bounds op-log growth + gives `SELECT data FROM
resources`. Note: `CREATE TABLE IF NOT EXISTS` does not migrate an existing table to add `data` — a fresh DB or a
manual `ALTER TABLE … ADD COLUMN data jsonb` is needed.

**Adversarial review (25 agents, 6 lenses) — confirmed + fixed:**
- *Swallowed op-log append error* (M): the fire-and-forget INSERT on the `open()`/object-`apply` path `.catch`ed
  into silence (data loss on the headline agent path). Now surfaced via an `onError?` option (default
  `console.error`) — await-reject is impossible since `ServerReplica` is sync-void.
- *`apply()` object-path skipped the existence check* (M): a server co-write to a missing id fabricated orphan
  op-log rows + a phantom doc. Now throws `NOT_FOUND` (parity with the string path + both siblings).
- *Fold loop had no try/catch* (M): one poison/un-decodable op-log row aborted the batch and could wedge the feed.
  Now per-row try/catch → log + skip.
- *`create()` / `delete()` were non-transactional* (M): a partial failure left an orphan meta row (or op-log
  rows that resurrect on recreate). Both wrapped in `sql.begin`.
- *`<table>_updates` length* (L): guarded against the 63-char identifier limit. *Agent cold-start* (L): the
  example's `agentEdit` now `await read()`s before `open()` to force a strong fold on a lagging node.

**Three findings (fixed/documented):**
1. **Concurrent-DDL race** across nodes booting on a fresh DB raises not only `42P07`/`23505` but also **`42710`**
   (`duplicate_object` — the table's implicit rowtype, `TypeCreate`). Swallow-list extended to `{42P07, 42710, 23505}`;
   without it node-2 crash-loops until node-1 wins the DDL. (store-pglite has the same latent gap — not touched here.)
2. **Idle nodes are invisible in topology** by design (`GossipPresence` skips broadcasting a zero-connection slice —
   "matches the Redis adapter"). A node only appears in the Control Center once a client connects to it. Documented in
   the example README so it doesn't read as a broken cluster (it was the trap behind this branch's original `/diagnose`).
   Not a store concern — Electric syncs regardless of who's watching.
3. **Empty-seed-map race (client-side, pre-existing parity):** a client that writes *before* catching up to the seed
   creates its own `shapes` map → concurrent-map clobber. The SPA gates writes on catch-up (`data === undefined` →
   "connecting"), same as `store-sync`/ai-canvas. Not a regression; noted for harness authors.

## Known trade-offs (accepted)

- Eventually-consistent catch-up (brief older-state flicker possible right after open; self-heals via CRDT
  merge) — same trade-off store-pglite documents, ACL excepted (strong).
- All docs held in RAM per node (always-folded) — fine for normal workloads; lazy+LRU is the upgrade path.
- Op-log grows with edit count — compaction deferred.
- Subscription latency = Electric sync latency (sub-second typical).
- Whole `updates`/`resources` tables synced to every node (no shape partitioning).
