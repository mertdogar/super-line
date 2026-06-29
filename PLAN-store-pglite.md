# PLAN — `@super-line/store-pglite` (Electric-synced, `clustering: 'self'`)

A durable, last-writer-wins **server Store** whose cross-node sync is owned by the store itself
(via ElectricSQL → a local PGlite replica per node), not by super-line's adapter. This is the
**first `clustering: 'self'` store** — every shipped store today (`memory`, `sqlite`, `sync`,
`sync-libsql`) is `relay`.

Decided in a grilling session (`/grill-me`) on 2026-06-29. Two non-obvious findings shaped it:

1. **`pglite-socket` (0.2.6) does NOT propagate `LISTEN/NOTIFY` over the pg-wire protocol.**
   Verified empirically (spike): PGlite implements notifications but only delivers them through
   its in-process `db.listen()` JS API; the socket server never emits async `NotificationResponse`
   messages to wire clients (even same-connection self-NOTIFY does not come back). So "all nodes
   connect to a PGLiteSocketServer and subscribe via NOTIFY" is impossible. The cross-node bus is
   **Electric**, not the socket.
2. **Electric strips super-line's `origin`** on the write→sync round-trip (it syncs only the row),
   so echo-break needs `origin` to travel through the DB as a column.

---

## Topology

```
                 writes + strong reads (postgres.js)
   node A ──────────────────────────────────────────┐
   node B ──────────────────────────────────────┐   ▼
   node C ──────────────────────────────────┐   ▼   central POSTGRES   (source of truth)
                                             ▼   ▼   ▲
   each node ALSO runs:                                │ logical replication
     in-memory PGlite { live, electricSync }  ◀────[ ELECTRIC service ]  (Docker)
        syncShapeToTable('resources')          HTTP /v1/shape (one-way, read-only → PGlite)
        live.changes() ─► onChange / onDelete ─► fan to LOCAL conns only
```

- **Central Postgres** = source of truth: all writes + all `read()`/`list()`/ACL checks (strong).
- **In-memory PGlite per node** (ephemeral; re-syncs on boot) = the **reactive change feed only**,
  via Electric one-way sync + `live.changes`.
- Genuine `clustering: 'self'`: the store owns cross-node propagation (Electric); super-line's
  adapter is unused for this store.

## Why `self` (vs a `relay` Postgres store)

The point is **Postgres+Electric is the only fan-out infra** — no separate super-line adapter
(Redis/libp2p) needed. The store's live feed fires `onChange` on every node, so super-line core
must fan those to **local connections only** (Electric already did the cross-node hop) — otherwise
re-publishing through the adapter double-fires.

---

## Central schema

```sql
CREATE TABLE resources (
  id     text  PRIMARY KEY,
  data   jsonb NOT NULL,
  access jsonb NOT NULL,
  origin text            -- carries super-line's echo-break origin through Electric
);
```
Electric publishes this table (logical replication). Local PGlite mirrors the same shape.

---

## Decisions (resolved in grilling)

| # | Decision | Choice |
|---|----------|--------|
| Backend | shared DB topology | Central Postgres + Electric; per-node in-memory PGlite replica |
| Bus | cross-node mechanism | **Electric sync** (NOT pglite-socket NOTIFY — proven broken) |
| Driver | central-PG writes/reads | **postgres.js** |
| Subscription | per-node change feed | local PGlite `live.changes('SELECT id,data,origin FROM resources', [], 'id')` |
| Consistency | `read()`/`list()`/ACL | **central Postgres** (strong); subscription is eventually-consistent |
| Local copy | persistence | **in-memory** PGlite, re-sync on boot, no `shapeKey` ("no local copy" = no on-disk copy) |
| Echo-break | `origin` survival | **`origin` column** on central table; surfaced via `live.changes` |
| Consistency model | write semantics | **LWW** (`model: 'lww'`), full-`data` replace, JSONB |
| Client half | reactive replica | **reuse `memoryStoreClient()`** (LWW) |
| `open()`/ServerReplica | server co-writer | **deferred** (sync `getSnapshot` conflicts w/ async driver) |
| Reconnect | missed-update gap | **owned by Electric** (resumable shape stream); no `onReconnect` core hook |
| Package name | naming | **`@super-line/store-pglite`** |
| Deliverable | scope | core change + package + vitest + docker-compose example |

---

## ServerStore surface (`clustering:'self'`, `model:'lww'`)

| method | behaviour |
|--------|-----------|
| `read(id)` / `list()` | SELECT from **central PG** (strong, authoritative) |
| `create(id,data,access)` | INSERT central PG (`origin` null/server); `ON CONFLICT` → `CONFLICT` |
| `apply(change)` | `UPDATE … SET data=$1, origin=$2 WHERE id=$3` central PG; 0 rows → `NOT_FOUND` (LWW replace) |
| `setAccess` / `delete` | UPDATE / DELETE central PG |
| `onChange(cb)` | fed by local `live.changes`: `insert`/`update` → `onChange({ id, update: row.data, origin: row.origin ?? '' })` |
| `onDelete(cb)` | fed by local `live.changes`: `delete` → `onDelete(id)` |
| `close()` | `shape.unsubscribe()` · `pglite.close()` · `sql.end()` |

Options: `{ pgUrl, electricUrl, table? }` (central PG conn string · Electric shape endpoint · table, default `resources`).

---

## Core change — `packages/core/src/store.ts`

Add one optional hook to `ServerStore`:
```ts
/** Subscribe to Resource deletions (self-clustering stores whose backend owns cross-node sync). */
onDelete?(cb: (id: string) => void): () => void
```
(Drop the earlier `onReconnect` idea — Electric's `shapeKey`/stream owns resume.)

## Server change — `packages/server/src/index.ts`

In the `store.onChange` wiring loop, branch on `store.clustering`:
- `self` → build the `SChangeFrame` and fan it to `members(s:<name>:<id>)` **locally** (`conn.sendRaw`);
  do **not** `adapter.publish`.
- `relay` → unchanged (`adapter.publish`).

Also for `self`:
- wire `store.onDelete?` → build `SDeleteFrame`, fan to local members (mirrors the `sch` path);
- `storeApi.delete` → **skip** `adapter.publish(sdel)` (the store's central DELETE → Electric →
  `live.changes` delete → `onDelete` → local `sdel` already handles it).

Relay-mode behaviour is untouched and backward-compatible.

---

## Tests (vitest, from root)

Kept Electric-free for unit coverage:
- **central-PG CRUD** via postgres.js against a **PGLiteSocketServer** stand-in (plain SQL over the
  wire works — only NOTIFY didn't), exercising `read/create/apply/setAccess/delete/list`.
- **`live.changes` → `onChange`/`onDelete` mapping** by writing **directly into the local PGlite
  table** (simulating an Electric sync push) and asserting the emitted events.
- **server `self` branch** fan-out with a fake in-memory `clustering:'self'` store + loopback
  transport + 2 connections (no PG/Electric at all) — proves local-only fan-out + `onDelete`→`sdel`
  + that `storeApi.delete` does not touch the adapter.

**Integration / example:** `docker-compose` (Postgres + Electric + N nodes) — browser-verified live
cross-node sync.

---

## Known initial-phase trade-offs (accepted)

- Strong reads + eventually-consistent change feed → a brief older-value flicker is possible right
  after `open()` if the local replica lags the central snapshot; self-heals (LWW).
- Subscription delivery latency = Electric sync latency (sub-second typical).
- `open()`/server-replica deferred; whole `resources` table synced to every node (no shape
  partitioning).

---

## Build order (TDD)

1. `core`: add `onDelete?` to `ServerStore`.
2. `server`: `self` branch (fan-out + `onDelete` + `storeApi.delete` skip-adapter) — fake-store tests.
3. `store-pglite`: central CRUD → `live.changes` mapping → wire `syncShapeToTable`.
4. `docker-compose` example.

Versions: `core` + `server` minor bump; `store-pglite` `0.1.0`. **Ask before publish.**

---

## Status (as-built, 2026-06-29)

**BUILT + verified; merged to `main` (= `origin/main`) and published** (`8600432`
`feat(store-pglite): self-clustering store over Postgres + Electric`, `d48ff63` mDNS-discovery refactor;
release `1d979b7`). `@super-line/store-pglite` now lives in `packages/store-pglite`.

- `core`: added optional `ServerStore.onDelete?`.
- `server`: `self` branch — onChange fans `sch` to local members only; `onDelete` fans `sdel` locally; `storeApi.delete` skips the adapter for `self`. Relay path untouched.
- `@super-line/store-pglite` `0.1.0`: `pgliteStoreServer({ pgUrl, electricUrl?, table?, db? })` — postgres.js central CRUD (jsonb via `sql.json`, read via `jsonb::text` + `JSON.parse` for cross-server determinism), in-memory PGlite + `electricSync` + `live.changes` (`__op__` INSERT/UPDATE→onChange, DELETE→onDelete), `origin` column for echo-break. Pairs with `memoryStoreClient()`.
- `examples/store-pglite`: docker-compose (Postgres + Electric + 2 nodes + writer/reader + Control Center). **Verified end-to-end in Docker**: writer@node-1 → Postgres → Electric → node-2 replica → reader@node-2, sustained. The example also runs a **broker-less libp2p adapter** as a *separate coordination plane* (no extra container) so the Control Center's topology/inspector sees the whole cluster — the `self` store still syncs via Electric and never touches the adapter (`getTopology` verified to return both nodes from either inspector). NB: the Control Center's topology is backed by the adapter presence directory, so an adapter-less self-store cluster shows only the node the CC is attached to — Electric is invisible to the inspector. **Peer discovery is mDNS** (BYO libp2p node, `peerDiscovery:[mdns()]`) — every node runs identical code with NO cluster-size knowledge (no node list / bootstrap / pre-computed peer IDs). Gotcha confirmed against libp2p docs: mDNS emits `peer:discovery` but does NOT auto-dial (only `bootstrap` does), so the node must `dial(evt.detail.multiaddrs)` for the gossipsub mesh + presence to form. Needs a multicast-passing network (Docker compose bridge OK; k8s often not → swap to pinned-seed + pubsub-peer-discovery).
- Tests: 4 server `self`-branch + 4 store (CRUD via PGLiteSocketServer stand-in + `live.changes` feed). Full suite 263 + new green; typecheck/lint/build clean.
- Adversarial review (9 agents) confirmed 1 real fix, applied: central DDL `CREATE TABLE IF NOT EXISTS` is not race-safe across nodes → swallow SQLSTATE `42P07`/`23505`.

**Not done (deferred):** `open()`/`ServerReplica` (sync `getSnapshot` vs async driver); shape partitioning (whole table synced to every node); persisted local replica (`shapeKey`).
