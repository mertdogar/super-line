---
id: T05
title: Lock PLAN-cloudflare
labels: [wayfinder:grilling]
status: open
assignee:
blocked-by: [T02,T03,T04]
---

## Question

Consolidate the charted decisions and the research/prototype findings into `docs/plans/PLAN-cloudflare.md` with exact signatures and semantics, resolve the residual micro-decisions, and lock it with the user. Author the ADR(s) — the snapshot/restore seam (connection state becomes reconstructible) and pluggable timers are both hard to reverse and surprising without context. Residuals to settle here: where the snapshot lives (attachment vs DO SQLite, per T01+T04); the timer seam's shape (server option? transport capability?); DO id routing (singleton vs id-from-request); `nodeKey`/node name sourcing from Worker env bindings; whether `SUPER_LINE_NODE_NAME`/`process.env` reads become a server option; the crypto-port scope per T02; the CRDT backend's op-log-vs-snapshot-per-doc model on DO SQLite (libsql precedent is snapshot-per-doc); which existing `ws`-transport tests become the contract tests for the new transport. From T04: the seam shape (`ConnectionSnapshot` + `adoptConnection`/`snapshotOf` + plugin `snapshotConnection`/`restoreConnection`), the replay-failure signal (new frame vs close), `env` persistence wording, `connectionId` mandatory on the snapshot path, chat open streams (hook vs keep-awake vs accept loss), `rooms[]` carried explicitly, `ctx` size guidance. Add glossary terms to CONTEXT.md as they crystallise (connection snapshot, hibernation wake).
