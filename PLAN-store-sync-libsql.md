# PLAN — `@super-line/store-sync-libsql` (durable CRDT store) + cluster-wide deletion fan-out

A new Store package that gives super-line a **durable CRDT** option: `store-sync`'s Yjs merge engine,
backed by **libsql** (Turso Cloud or self-hosted `ghcr.io/tursodatabase/libsql-server`/sqld) so Resources
survive a restart. It is built as a **thin wrapper around `syncStoreServer`** — zero changes to
`store-sync`.

The work splits cleanly into two deliverables:

- **Part A — deletion fan-out** (a super-line-*wide* framework feature): a single `srv.store(ns).delete(id)`
  now removes the Resource on every node, and subscribed clients learn about it through an **explicit
  `deleted` signal**. This is a prerequisite the durable store relies on (without it, a shared backend
  resurrects deleted rows), and it fixes a real gap that affects `store-memory`/`store-sync`/`store-sqlite`
  too.
- **Part B — the package**: `libsqlSyncStore(opts): Promise<ServerStore>`, snapshot-per-resource persistence
  to one shared libsql, debounced, with eager rehydrate-on-startup.

## Goal

Today every Store either loses state on restart (`store-memory`, `store-sync`) or is durable but
**last-writer-wins** (`store-sqlite`). There is no durable Store with **merge** semantics — and "merge,
durable, works against Turso/sqld" is exactly what's needed when **both AI agents and human users edit the
same Resources concurrently** and neither's edits may be silently lost.

`store-sync` already provides the merge engine (Yjs via `@super-store/store`), already runs
`clustering: 'relay'`, and already implements the server-side co-writer `open()`. It is purely in-memory.
We add libsql as a **durable backing** behind it and nothing else.

## How we got here (the model decision)

The first instinct was an LWW driver-swap of `store-sqlite`. Grilling killed it:

- A shared Turso/sqld backend wants `clustering: 'self'` (persist once, the adapter still notifies every
  node's subscribers via `index.ts:1048`) — **not** `relay`, because `relay`'s echo-break assumes a
  **synchronous** `apply()` (`index.ts:1045`: `void store.apply()` then a sync `finally` resets the
  `relaying` flag). libsql's `apply` is `await`-async → the flag resets before `onChange` fires → echo
  storm. So an async LWW store was forced onto `self`.
- But the requirement is **agents and users co-editing the same Resource with no lost edits**. That is a
  *consistency-model* requirement (LWW vs CRDT), independent of where the writer runs. LWW clobbers by
  definition: a client holds a full-value replica and sends the whole value up; the server can only
  `UPDATE data = ?` (full replace). `json_set`-style server-side atomic RMW fixes *co-writer* clobbering
  but **not** a client's full-value write. Making agents into clients doesn't help — it makes *everyone* a
  full-value clobberer.
- Therefore: **CRDT**. And CRDT flips every earlier sub-decision back to the simple answer — `relay` is
  correct (deltas commute), `store-sync`'s `apply` is **synchronous** (in-memory Yjs merge + `onChange`
  before any await), so the echo bug never bites; relay also keeps every node's `open()` co-writer
  converged for free (`handleStoreRelay` → `store.apply` → Yjs merge → `onChange` → `subscribe`). All of
  the `self` / `json_set` / in-memory-cache / "notify-only core hook" machinery from the LWW exploration is
  **dropped**.

## Decisions (locked during design review)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Consistency model | **CRDT** (merge-required: agents + users co-edit the same Resources) |
| 2 | Build approach | **Thin wrapper around `syncStoreServer`** — persistence via an extra `onChange` subscriber; **zero changes to `store-sync`** |
| 3 | Clustering | **`relay`** (CRDT-native; converges `open()` co-writers; `store-sync.apply` is synchronous → relay echo-break holds) |
| 4 | Persistence granularity | **Snapshot-per-resource**, debounced full-state overwrite (not an append-only update-log) |
| 5 | Backend topology | **One shared libsql** (Turso Cloud / sqld); **all nodes persist** for v1 (leader-persister deferred) |
| 6 | Engine assumption | **Engine-agnostic single-writer**; **no MVCC / `BEGIN CONCURRENT` dependency** (TursoDB-only + experimental; MVCC is conflict-retry on same-row, not merge) |
| 7 | Connection mode | **Remote-only** v1 (`url` → `file:`/`libsql://`/`http://`); **embedded replicas deferred** (their stale-catch-up-read hole needs sync-on-read) |
| 8 | Store factory | **Async** `await libsqlSyncStore(opts)` — **eager-rehydrate all Resources before returning** (no fan-out storms; sync `open()` always finds its doc) |
| 9 | Snapshot storage | `state TEXT` = base64 of `encodeState()` (exactly what `inner.read()` returns); `access TEXT` = JSON `AccessRules` |
| 10 | Client half | **Unchanged `syncStoreClient`**; agents connect *as clients* (in-process via `transport-loopback`, or over the wire) — same merge + ACL path as users |
| 11 | Deletion | **Cluster-wide fan-out** (new framework feature), all relay stores benefit; client sees an **explicit `deleted` signal** (not ambiguous `undefined`) |

### Why a wrapper, not a fork or a `store-sync` edit (decision 2)

`store-sync` already exposes the one seam durability needs: `onChange` fires for **every** integrated delta
(`store-sync/src/index.ts:81`). So the durable store *composes* around it:

- **persist** = an additional `onChange` subscriber that snapshots the doc to libsql (debounced);
- **rehydrate** = at startup, read each row and rebuild the doc via `inner.create(id, {}, access)` +
  `inner.apply({ id, update: <state>, origin: 'restore' })`;
- **delegate** `read`/`list`/`apply`/`open`/`model`/`clustering` straight through;
- wrap only `create`/`delete`/`setAccess` to also touch libsql.

Persistence runs in a *separate* subscriber, so `inner.apply` stays synchronous and relay-safe — durability
is async and **off the hot path**. Reuses 100% of the CRDT engine; touches `store-sync` not at all. (A
fork was considered and rejected — it would duplicate the Yjs/relay/`open()` wiring and drift.)

### Why CRDT rehydrate must apply the encoded update, not a JSON snapshot

Rehydration must `applyUpdate(encodedState)` to **preserve Yjs history**. Decoding to a JSON object and
re-`create`ing would mint a fresh doc with that content but **lose the update history** other peers carry →
it would fail to converge with them. So we store and replay `encodeState()` bytes (base64), never the JSON
snapshot.

### Why one shared libsql resurrects deletes — and why Part A is required (decisions 5, 11)

`store.delete(id)` is called **only locally** today (`server/src/index.ts:1232`); there is no adapter
publish for it, so deletion is node-local in `store-memory`/`store-sync`/`store-sqlite`. With **one shared
libsql + all-nodes-persist**, node A's `delete(id)` drops its doc and `DELETE`s the row, but node B still
holds the doc and its next debounced flush **rewrites (resurrects)** the row. The only correct fix is to
propagate the deletion so every node drops the doc and cancels its pending flush — i.e., **Part A**.

## Part A — deletion fan-out (framework feature)

Deletion rides the path changes already use (adapter + the Resource channel `store:<name>:<id>`), as a
*distinct* frame (deletion is structurally not a mutation — no `StoreChange.update` tombstone overloading).

### Wire — `packages/core/src/wire.ts`

```ts
// Server -> Client: a Resource was removed (fan-out of a delete on a Resource the client subscribes to)
export interface SDeleteFrame {
  t: 'sdel'
  n: string  // store name
  id: string // resource id
  nd?: string // origin NODE id; stamped for cross-node relay dedup, ignored by clients
}
export type ServerFrame =
  | ResFrame | ErrFrame | EvtFrame | PubFrame | SReqFrame | SChangeFrame
  | SDeleteFrame   // <-- new
  | PingFrame | PongFrame
```
(Also re-export `SDeleteFrame` from `packages/core/src/index.ts` alongside `SChangeFrame`.)

### Core replica surface — `packages/core/src/store.ts`

`ResourceReplica` gains one method so the client half can be told its Resource vanished and notify
subscribers (own deleted-state, distinct from `undefined`):

```ts
export interface ResourceReplica {
  getSnapshot(): unknown
  subscribe(cb: () => void): () => void
  set(data: unknown): StoreChange | null
  update(partial: unknown): StoreChange | null
  delete(path: (string | number)[]): StoreChange | null
  applyRemote(change: StoreChange): void
  seed(snapshot: unknown): void
  applyDelete(): void   // <-- new: mark deleted + notify subscribers
}
```
Both `memory`/`sync` `*Replica` classes implement `applyDelete()` (set an internal `deleted` flag, fire
listeners). `LwwReplica` and `SyncReplica` already own a listener set + `notify`.

### Server — `packages/server/src/index.ts`

- `storeApi[name].delete(id)` (≈`:1231`): after `await store.delete(id)`, publish the delete frame:
  ```ts
  void adapter.publish(STORE + name + ':' + id,
    serializer.encode({ t: 'sdel', n: name, id, nd: instanceId } satisfies SDeleteFrame))
  ```
- `handleStoreRelay` (`:1046`): branch on frame type. Decode → if `t === 'sdel'`: forward raw payload to
  local subscriber conns (existing `:1048` loop), and when `frame.nd !== instanceId` call
  `void store.delete(frame.id)` (idempotent — drops the in-memory doc; for libsql cancels the pending
  debounce + `DELETE`s the row). If `t === 'sch'`: the existing change path.

### Client — `packages/client/src/index.ts`

- New branch beside `frame.t === 'sch'` (`:366`): on `t === 'sdel'`, look up the entry, set
  `entry.deleted = true`, and `for (const replica of entry.replicas) replica.applyDelete()`.
- `ResourceHandle` (`:97`) gains `readonly deleted: boolean` (reads `entry.deleted`). The handle's existing
  `subscribe` fires (via `applyDelete`'s notify), so consumers re-read `getSnapshot()` **and** `deleted`.

### React — `packages/react/src/index.ts`

- The store hook (`:134`) returns a `deleted` field alongside `data`, re-read from `handle.deleted` on each
  `subscribe` fire (UI can show "removed" vs a loading spinner).

### Blast radius (accepted)

This is intentionally **super-line-wide**: every relay store gains cluster-wide deletion, and `core` /
`client` / `react` all gain the `deleted` surface. Authorization is unchanged — `delete` stays
server-authoritative (`srv.store(ns).delete`); the fan-out only *notifies* clients.

## Part B — `@super-line/store-sync-libsql`

New package mirroring `store-sqlite`'s layout (`package.json` + `src/index.ts`, tsup, ESM-only). Deps:
`@super-line/core`, `@super-line/store-sync`, `@libsql/client` (and `@super-store/store` transitively).

### API

```ts
export interface LibsqlSyncStoreOptions {
  url: string                 // file: / libsql:// (Turso) / http:// (sqld)
  authToken?: string          // Turso Cloud
  table?: string              // default 'resources' (validated /^[A-Za-z_][A-Za-z0-9_]*$/)
  debounceMs?: number         // default 250 — coalesce rapid edits into one snapshot write
  resolveOptions?: (id: string) => DocOptions  // MUST match the client's (existing store-sync rule)
}

// async: rehydrates ALL resources before returning a ready ServerStore
export function libsqlSyncStore(opts: LibsqlSyncStoreOptions): Promise<ServerStore>
```

### Schema

```sql
CREATE TABLE IF NOT EXISTS "<table>" (
  id     TEXT PRIMARY KEY,
  state  TEXT NOT NULL,   -- base64 of encodeState()
  access TEXT NOT NULL    -- JSON AccessRules
);
```

### Behavior

| Method | Implementation |
|--------|----------------|
| factory | `createClient({url, authToken})`; `CREATE TABLE IF NOT EXISTS`; build `inner = syncStoreServer({resolveOptions})`; wire persist subscriber (guarded by a `rehydrating` flag); **`SELECT id, state, access`** all rows → for each, `inner.create(id,{},access)` + `inner.apply({id,update:state,origin:'restore'})`; clear flag; return wrapped store |
| `onChange` persist subscriber | on each change for `id`, **debounce** (per-id timer, `debounceMs`): `state = inner.read(id).state` → `INSERT INTO t(id,state,access) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state`; skip while `rehydrating` |
| `create(id,data,access)` | `inner.create(...)` + immediate `INSERT` of initial `state`+`access` (create does **not** fire `onChange` — `store-sync:80`) |
| `apply` / `read` / `list` / `open` / `model` / `clustering` | delegate to `inner` |
| `setAccess(id,access)` | `inner.setAccess(...)` + `UPDATE t SET access=? WHERE id=?` |
| `delete(id)` | cancel pending debounce timer for `id`; `inner.delete(id)`; `DELETE FROM t WHERE id=?` (idempotent) |
| `close()` | flush pending timers; `inner` has none; `client.close()` |

### Single-writer note (decision 6)

All cluster writes serialize through one libsql writer; with all-nodes-persist, each node flushes the
(converging) snapshot → bounded redundant writes. Snapshot upserts are single autocommit statements; under
contention libsql/Hrana queues server-side. A tiny retry-on-`BUSY` may be added if observed.

## Implementation slices (TDD, ordered)

Land **Part A first** (Part B depends on it for correct deletion).

1. **A1 — wire + core replica.** Add `SDeleteFrame` + re-export; add `ResourceReplica.applyDelete()` to the
   interface and to `LwwReplica`/`SyncReplica`. Unit: `applyDelete` flips `deleted` + notifies.
2. **A2 — server fan-out.** `storeApi.delete` publishes `sdel`; `handleStoreRelay` branches. Integration
   (2 servers + loopback adapter, `store-memory`): delete on node A → node B's `store.delete` called,
   subscribed conn on B receives `sdel`.
3. **A3 — client + react `deleted`.** Client `sdel` branch + `ResourceHandle.deleted`; hook surfaces
   `deleted`. Integration: subscribed client sees `deleted` flip true.
4. **B1 — package skeleton + snapshot persist.** `libsqlSyncStore` against `file:`; create/edit/read/list;
   debounced upsert. Unit: edit → row reflects `encodeState()` after debounce.
5. **B2 — rehydrate-on-restart.** New instance over the same `file:` restores all docs (history-preserving
   `applyUpdate`). Unit: write → close → reopen → state intact; concurrent-field merge survives round-trip.
6. **B3 — delete (no resurrection) + setAccess.** `delete` cancels debounce + removes row; `setAccess`
   persists. Unit: delete → reopen → gone.
7. **B4 — multi-node integration.** 2 servers + **shared `file:`** libsql + loopback adapter: convergence,
   persistence, **deletion fan-out** end-to-end (node A delete → node B drops + client `deleted`).

All via root `pnpm test` (vitest), `pnpm typecheck`, `pnpm lint` (oxlint), `pnpm build`.

## Known limitations (accepted)

- **Crash window.** Debounced async persist loses ≤ `debounceMs` of un-flushed deltas on a crash; they
  survive in connected clients' replicas and reconverge on reconnect. A `flush()`/await-on-critical-write is
  deferred.
- **Write amplification.** All-nodes-persist writes the same converging snapshot N× (debounce-bounded).
  Fast-follow: a **leader-persister** (`persist: true` on one node) drops it to 1×.
- **Snapshot rewrite cost.** Each debounced flush rewrites the whole doc — fine for KB-sized, human-paced
  docs; an **append-only update-log + compaction** is the optimization for very large/hot docs (same
  wrapper, same contract).
- **Deletion startup race.** An `sdel` arriving on a node mid-rehydrate (doc not yet built) is a no-op;
  CRDT self-heals on the next delta/subscribe.

## Out of scope / deferred

Embedded replicas (sync-on-catch-up-read); update-log + compaction; leader-persister; MVCC/`BEGIN
CONCURRENT` (TursoDB); lazy-load (its sync-`open()` snag); a single-call deletion fan-out *authorization*
model beyond today's server-authoritative `delete`.
