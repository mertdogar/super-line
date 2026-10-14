---
id: T07
title: Build @super-line/transport-cloudflare
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [T06,T15]
---

## Question

The DO WebSocket transport: a `ServerTransport` over the Hibernation API (accept, tag, message/close/error routing to `RawConn`), a `fetch` helper the Worker/DO uses to route upgrades (and the reserved-connection subprotocol dance that `transport-websocket` does, including the 4401-after-upgrade refusal), socket-level liveness via auto-response replacing the server heartbeat (the timer seam from T05), and **wake**: on construction, adopt `ctx.getWebSockets()` through the snapshot/restore seam. The core half of the seam is T15; this ticket builds only the Cloudflare half per PLAN-cloudflare §4 (`routeToNode`, `createDurableNode`, `_sl_conn` snapshot table, 4409 fallback, auto-response liveness, `onHold` → `waitUntil`) and proves it in the workers lane. Peer-dep on core with a hand-written range.
