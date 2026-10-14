---
id: T04
title: Prototype the connection snapshot/restore seam
labels: [wayfinder:prototype]
status: closed
assignee: claude session 2026-10-14 (T04)
closed: 2026-10-14
blocked-by: [T01]
---

## Question

The hardest unknown: can a live connection's server-side state be captured, persisted, and rebuilt on a fresh server instance such that the client never notices? Prototype it on the loopback transport, no Cloudflare involved. Inventory every piece of per-connection state the server holds (ctx/identity/env, rooms/topics, collection subscriptions + their query IR, open CRDT docs, in-flight requests, streaming chat writers, inspector reserved-connection state, plugin-owned per-connection state via `setup(ctx)`), classify each as *restorable from a snapshot*, *re-derivable*, or *lost* (and whether lost is acceptable — e.g. an in-flight request on a hibernated socket). Produce a rough `exportConnection(connId) → Snapshot` / `adoptConnection(raw, snapshot)` shape and measure a realistic snapshot size (decides attachment vs DO SQLite given T01's limit). Surface what plugins must contribute (a per-connection snapshot hook?). Throwaway code; the answer is the inventory + shape + size, recorded in the resolution.

## Resolution

**Yes — transparent resumption works, and the snapshot is tiny.** A fresh server instance adopted a still-open socket from a snapshot and the client resumed topics, row subscriptions (filter honoured), an open CRDT doc (both directions), requests and `env` with zero `disconnect`/`reconnect` lifecycle events. Prototype: [`assets/proto-snapshot/connection-snapshot.proto.test.ts`](../assets/proto-snapshot/connection-snapshot.proto.test.ts) (copy back into `packages/server/test/` to rerun with `pnpm exec vitest run <file>`; it uses the vitest aliases).

### The key simplification

The snapshot is **not** the server's internal state. It is `{ AuthOutcome, the client's live subscribe frames }`: the server's per-connection registries (`conn.channels`, rows `connState`, CRDT `d:` channel membership, reserved-conn `reservedBridges`) are all *derived* from `sub`/`csub`/`cdopen` frames the client sent. Adopt = run the normal `acceptConn(raw, auth)` and **replay** the recorded frames with their acks muted (the client has no pending request for them). Nothing is re-snapshotted: on a single-node DO nothing can change while the object is hibernated, so the client's rows/docs are already current. The server never needs an "export" of its registries at all — recording happens at the ingress of each frame, which is the one place every subscribe already passes.

### Inventory of per-connection state

| State | Where | Class | Notes |
|---|---|---|---|
| `id`, `role`, `ctx`, `env`, `transport`, `connectedAt` | `Conn` | **restorable** | = `AuthOutcome` + `connectedAt`. `connectionId` must be pinned in the snapshot (plugin-auth already sets it = sessionId; otherwise a fresh uuid breaks `toConn(id)`). |
| `principal` | `Conn` | re-derivable | `identify(conn)` reruns on adopt. |
| topics (`t:` channels) | `conn.channels` | **restorable** | replay `sub` frames. |
| rooms (`r:` channels) | `conn.channels` | **restorable, but not from frames** | joined by host handlers; snapshot carries `rooms: string[]` and adopt re-`room(r).add`s. (Prototype proved the loss: `room('lobby').size` 1 → 0.) |
| `c:<id>` / `u:<uid>` channels | `conn.channels` | re-derivable | acceptConn joins them. |
| row subscriptions (`subs` query IR + cached policy filter) | `collections/rows.ts connState` | **restorable** | replay `csub` (minus later `cuns`); policy **re-evaluated** on wake — good. |
| open CRDT docs | `d:` channel membership | **restorable** | replay `cdopen` (minus `cdclose`); read policy re-evaluated. |
| `conn.data` | `Conn` | **lost → re-seeded** | host scratch, untyped/unserializable; `onConnection` reruns on adopt and may re-seed. Document. |
| in-flight requests (`handleReq`, `originWaiters`, `ownerRouting`) | server | n/a | a DO with an in-flight event never hibernates; a deploy drops the socket anyway. |
| heartbeat (`lastPingAt`/`lastPongAt`/`missedPongs`) | `Conn` | lost, irrelevant | transport-owned on DO (auto-response). |
| presence descriptor / `registered` | adapter | re-derivable | in-memory adapter on a DO; acceptConn re-registers. |
| plugin-auth session | `sessions` collection | durable | `sessionId` rides in `ctx`; `onDisconnect→endSession` keeps working after wake. |
| plugin-chat open streams (`streams`, `connStreams`, `flushTimer`, `lane`) | plugin memory | **lost** | `flushTimer` blocks hibernation only while pending; a stream idle between pushes CAN be hibernated out from under. Options for T05: a per-connection plugin snapshot hook, or declare "a node with open streams is non-hibernating" via a `waitUntil`-style keep-awake, or rely on `sweepStale` + client re-start. |
| plugin-inspector reserved conn (`reservedBridges`) | server | **restorable** | reserved conns dispatch `sub` through `onReservedFrame` — the same replay covers them, provided the reserved `AuthOutcome` (role + subprotocol auth) is snapshotted. |
| plugin-queue | — | none per-conn | — |

### Proposed seam shape (for T05 to lock)

```ts
// core/transport.ts — what a transport hands back on wake
interface ConnectionSnapshot {
  auth: AuthOutcome           // role, ctx, env, transport, connectionId (REQUIRED here)
  connectedAt: number
  rooms: string[]
  frames: ClientFrame[]       // the live sub/csub/cdopen set, already net of unsub/cuns/cdclose
  plugins?: Record<string, unknown>  // per-plugin opaque contribution (chat streams, …)
}
// ServerTransport hooks gain:
//   onConnection(raw, auth)                     (unchanged)
//   adoptConnection(raw, snapshot)              (acceptConn + rooms + muted replay + plugin restore)
//   snapshotOf(connId): ConnectionSnapshot      (server keeps it current at frame ingress; transport persists)
// Plugin: snapshotConnection?(conn) → unknown · restoreConnection?(conn, data)
```
The transport decides *when* to persist (Cloudflare: after every frame that changed the set, to DO SQLite keyed by connection id; attachment holds only the id). Alternative with less core surface: persist the raw frames themselves and let the DO transport replay them through the ordinary `onMessage` path with a "muted" flag — the prototype did exactly this with ~30 lines, so the seam can start minimal.

### Size (JSON bytes, 16 384-byte attachment limit)

| shape | bytes | fits attachment |
|---|---|---|
| prototype conn (2 topics, 1 sub, 1 doc, small ctx) | 432 | yes |
| auth only (plugin-auth ctx with claims + sealed + env) | 611 | yes |
| chat-like: 5 topics, 10 subs (3-clause filters + orderBy), 2 docs | 4 014 | yes |
| dashboard: 10 topics, 40 subs, 5 docs | 13 687 | yes, barely |
| heavy: 20 topics, 100 subs, 50 docs | 36 252 | **no** |

Verdict: **DO SQLite keyed by connection id, attachment = connection id only** (as T01 expected). ~90 bytes per topic, ~290 per row sub, ~70 per doc; `ctx`/`env` dominate small connections. Worth a `ctx` size warning in docs (hosts stuffing large claim sets).

### Surfaced for T05

1. **Replay failure on wake** (policy now denies, collection removed): the prototype mutes the `err` so the client's subscription is *silently dead*. Need either a new server→client frame ("subscription ended: <reason>") that the client routes to `onStoreError('resubscribe')`, or fall back to closing that socket so the client's existing reconnect path re-establishes (the "internal fallback" the map allows). Recommend the frame — it is also useful outside Cloudflare.
2. **`env` persistence**: `Conn.env` is documented "never persisted" (presence directory). Persisting it in DO SQLite is server-private and equivalent to memory; confirm and reword the doc-comment.
3. **`connectionId` becomes mandatory in the snapshot path** — today it is optional on `AuthOutcome`.
4. **Chat streams**: pick between plugin snapshot hook vs keep-awake vs accept loss (see inventory).
5. **Rooms** need the `rooms[]` field since no frame reproduces a host-side `room.add`.
6. The server re-sends an `env` frame on adopt (acceptConn always does); the client handles it idempotently — keep, it is harmless and confirms liveness.
