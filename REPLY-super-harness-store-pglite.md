# Reply — adopting `@super-line/store-pglite` as super-harness's durable tree store

**From:** super-line team → super-harness team
**Re:** `HANDOFF-super-harness-store-pglite.md` §1–§4
**Bottom line:** Adopt store-pglite as-is. It's **already published** (`0.1.0` on npm). Your write path works on it today with no super-line change. We're shipping **one** tiny addition (`origin` on `write()`); everything else in the handoff is either "already solved" or "your side." The durable store is the *right* tool here — because Electric already does the multi-node reload propagation you need.

---

## First, a correction that unblocks you now

The handoff's premise "store-pglite is still `0.1.0`, unpublished, needs a publish before you can depend on it" is **stale**. It's published:

```
npm view @super-line/store-pglite version   # → 0.1.0
```

`pnpm add @super-line/store-pglite@0.1.0` works today. The config surface (`pgUrl` / `electricUrl` / `table` / `db`) is stable. No publish is blocking you.

---

## §1 — Streaming tokens through the store (the big one)

**We're pushing back on the *granularity*, not the *approach*.** Keep the durable store as the single source of truth — but stop writing the whole doc per token.

Your requirement — *"a tab refresh, or a new tab on any node, must render the actual mid-turn state"* — is exactly why the store is correct here, and why an events-only design would be **wrong**:

- A fresh page load has **zero event history**. Events are ephemeral; a client that wasn't connected when a delta was broadcast never sees it. So mid-turn state *must* be durably readable at load time, from any node. Events alone cannot serve this.
- **store-pglite already gives you that for free.** A write to central PG propagates through Electric to *every node's* replica → `onChange` → WS fan-out. A new tab on a *different* node reads that node's replica (current to ~write + Electric latency) and renders correctly. An events-based design would have to *reinvent* this with per-node in-memory accumulators and sequence-number seam reconciliation — reimplementing Electric.

So keep store-as-truth. The only fix is **granularity**:

> **Debounce/coalesce the writes in your sink.** Flush the growing doc via `handle.write()` at most every ~100–250 ms, instead of once per stream event. Render the client purely from the store snapshot + `onChange`. Reload = `read` the store.

- Central-PG load drops from token-rate → ~10 writes/sec/active-turn, tunable by the debounce interval.
- **Coalescing lives in your sink, not in store-pglite.** Cadence is app policy — how much mid-turn durability you want vs. write cost — and it varies per consumer. We keep the store dumb.

**Escape hatches (don't build until measured):**
- If Electric's added latency makes the stream feel chunky → add an ephemeral **events tail** *purely* for live smoothness; the store still debounce-persists for reload. The seam is cosmetic for text.
- If the O(n²) full-doc-write bytes (each flush re-sends the whole growing doc) become the PG bottleneck → consider `@super-line/store-sync-pglite` (CRDT), which sends only new-token deltas. Not the first move.

---

## §2 — `open()` co-writer parity + `origin` on `write()`

These have opposite answers.

**We will *not* add `open()` to store-pglite.** The `UNSUPPORTED` throw stays, deliberately. On a self-clustering store `getSnapshot()` can't read the lagging replica, so an `open()` would have to seed a local cache from a strong read — meaning the co-writer sees *its own* writes immediately but *other* writers' writes only after the Electric round-trip. That's a different consistency model than every other `open()`. An API that looks identical but behaves differently is a footgun. Use `write()` / `apply()` on self stores; the throw is an honest signal, not a gap.

**We *are* adding an optional `origin` to `write()`** so you lose nothing by dropping `open()`:

```ts
write(id: string, data: unknown, opts?: { origin?: string }): Promise<void>
```

This makes `write()` symmetric with the `open()` that already honors a custom origin, and preserves your `'harness'` Control Center attribution on sink co-writes. (Today `write()` hard-codes `'server'`.) Ships in the next super-line release; until then, sink writes show as `'server'`.

---

## §3 — Subscribe-snapshot vs. live-delta ordering race

**Not a bug on store-pglite. Drop the workaround.** We traced the server open path (`handleStoreOpen`):

```
read snapshot → subscribe to channel → send snapshot   // synchronous; no await between subscribe and send
```

- The snapshot is sent **synchronously** right after subscribe — no `onChange` callback can interleave in that continuation. On the wire, for that conn, **snapshot always precedes any `sch` delta**, and on the client the `sopen` reply's `seed` runs (microtask) before the next message's `applyRemote`. No clobber.
- Self-clustering makes it *safer*: the only residual is the `read → subscribe` gap, and on store-pglite it **can't be permanently lost** — Electric continuously converges the replica to head and re-fires `onChange`. Your topology *heals* the gap the standing note worried about (that note came from **relay** stores).
- Your own e2e (co-writer convergence over real Electric, `26bcbb1`) already converges.

So: key your assertions directly off the store, not the event-stream workaround. **If you produce a failing repro on store-pglite, send it and we'll fix the server-side ordering** (subscribe→buffer→read→send→replay). We won't add speculative core machinery for a race we can't reproduce on your store.

---

## §4 — Operational / contracts

- **Publish:** done (see top). Config surface stable.
- **Idempotent-create:** confirmed blessed. `create()` is `INSERT … ON CONFLICT DO NOTHING` → throws `CONFLICT` on conflict (swallow it). A *genuine* create failure isn't masked — the row won't exist, so the following `write()` → `apply()` → `UPDATE` returns 0 rows and throws `NOT_FOUND`. The error re-surfaces; the pattern is safe.
- **Delete fan-out to remote-node clients:** confirmed. `srv.store(ns).delete(id)` → central `DELETE` → Electric delete → *every* node's replica `live.changes` DELETE → `onDelete` → core fans `sdel` to that node's local subscribers. Because Electric hits every node, a client on *any* node with the resource open receives the `sdel`.

---

## Your action list (all super-harness-side)

1. `pnpm add @super-line/store-pglite@0.1.0`; add a `{ type: 'pglite', pgUrl, electricUrl, table }` variant to `backend()` in `serve.ts`.
2. In `sink.ts`, replace the `open().set(doc)` co-writer with `await ns.write(id, doc)` (drop `nodeReplicas`/`nodePending`/`threadReplica`). Once our `origin` change lands, pass `{ origin: 'harness' }`.
3. **Debounce the sink writes** (~100–250 ms per resource) instead of per stream event. Render from store `onChange`; reload = `read`.
4. Drop the `wire.test.ts` event-stream workaround for §3; assert against the store directly.

## What super-line is doing on our side

- Adding optional `origin` to `ServerStoreHandle.write()` (the only code change). Everything else: no change — confirmed working.
