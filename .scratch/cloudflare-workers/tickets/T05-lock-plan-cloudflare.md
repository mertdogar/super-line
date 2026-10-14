---
id: T05
title: Lock PLAN-cloudflare
labels: [wayfinder:grilling]
status: closed
assignee: claude session 2026-10-14 (T05)
closed: 2026-10-14
blocked-by: [T02,T03,T04]
---

## Question

Consolidate the charted decisions and the research/prototype findings into `docs/plans/PLAN-cloudflare.md` with exact signatures and semantics, resolve the residual micro-decisions, and lock it with the user. Author the ADR(s) — the snapshot/restore seam (connection state becomes reconstructible) and pluggable timers are both hard to reverse and surprising without context. Residuals to settle here: where the snapshot lives (attachment vs DO SQLite, per T01+T04); the timer seam's shape (server option? transport capability?); DO id routing (singleton vs id-from-request); `nodeKey`/node name sourcing from Worker env bindings; whether `SUPER_LINE_NODE_NAME`/`process.env` reads become a server option; the crypto-port scope per T02; the CRDT backend's op-log-vs-snapshot-per-doc model on DO SQLite (libsql precedent is snapshot-per-doc); which existing `ws`-transport tests become the contract tests for the new transport. From T04: the seam shape (`ConnectionSnapshot` + `adoptConnection`/`snapshotOf` + plugin `snapshotConnection`/`restoreConnection`), the replay-failure signal (new frame vs close), `env` persistence wording, `connectionId` mandatory on the snapshot path, chat open streams (hook vs keep-awake vs accept loss), `rooms[]` carried explicitly, `ctx` size guidance. Add glossary terms to CONTEXT.md as they crystallise (connection snapshot, hibernation wake).

## Resolution

**Locked.** `docs/plans/PLAN-cloudflare.md` holds the exact signatures and semantics; ADR-0027 (a connection is reconstructible from its snapshot) and ADR-0028 (liveness belongs to the transport) are written and indexed; CONTEXT.md gained *Connection snapshot*, *Hibernation wake*, *Busy token*.

Decisions, all user-confirmed (round 1: 1a 2a 3y 4a 5y 6y 7y 8y 9y 10y; round 2: 11a 12y 13y 14a):

1. **Formal seam in core**: `ConnectionSnapshot { auth(+connectionId), connectedAt, rooms, frames, plugins? }`; hooks gain `adoptConnection` / `snapshotOf`; transport gains `onSnapshotChanged` (**push**, synchronous) and `liveness`; plugins gain optional `snapshotConnection` / `restoreConnection`.
2. **Replay refusal → new `end` frame** (kind topic | collection | doc), routed to `onStoreError('resubscribe')` / `onError`; usable by any server.
3. **Liveness owned by the transport**: `liveness: 'socket'` suppresses the server timer; DO auto-response for `{"t":"ping"}`; client opt-in `keepalive`; `lastSeenAt` = last wake on a hibernating node.
4. **Chat streams → busy token** `PluginContext.hold()` mapped to `waitUntil`; stream snapshot/restore stays fog.
5. **DO id routing**: `routeToNode(req, ns, { selectId })`, singleton `idFromName('super-line')` default; `createDurableNode` helper.
6. **Node identity**: helper defaults `nodeKey` to `ctx.id.toString()`; no server change; `process.env` read stays guarded.
7. **CRDT on DO SQLite = snapshot-per-doc** (libsql model), 2 MB ceiling documented.
8. **Crypto port = verification only**, folded into the workers-lane ticket; T08 closed.
9. **Contract tests**: three transport-neutral ws tests ported + the hibernation trio; Node-undici cases stay ws-only.
10. **ADRs 0027 + 0028**; no "DO is the node" ADR (scoping, recorded on the map).
11. Snapshot persistence is **push** (`onSnapshotChanged`), never pull.
12. **New ticket T15** "Build the connection snapshot seam on loopback" — the core/server/client half, fast-lane TDD; T07 now blocks on it.
13. **Control Center against a DO node: nothing special** — the inspector rides the ported reserved-subprotocol path, the CC dials the Worker URL; removed from fog.
14. **Queue cron on DO alarms: out of scope** — a queue-running node does not hibernate (documented); a fresh effort if wanted.

Also settled without a question: rooms carried explicitly in the snapshot; replay ids from a reserved range ≥ 2^30; a socket with no snapshot row is closed with 4409 (the only visible wake); drift refusal surfaces as failing operations, never a constructor throw; `IN` lists chunked at 90 params, >98 columns refused at construction.
