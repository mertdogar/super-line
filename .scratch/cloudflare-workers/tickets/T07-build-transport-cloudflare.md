---
id: T07
title: Build @super-line/transport-cloudflare
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [T05,T06]
---

## Question

The DO WebSocket transport: a `ServerTransport` over the Hibernation API (accept, tag, message/close/error routing to `RawConn`), a `fetch` helper the Worker/DO uses to route upgrades (and the reserved-connection subprotocol dance that `transport-websocket` does, including the 4401-after-upgrade refusal), socket-level liveness via auto-response replacing the server heartbeat (the timer seam from T05), and **wake**: on construction, adopt `ctx.getWebSockets()` through the snapshot/restore seam. Includes the core/server half of the seam itself (export/adopt + plugin per-connection snapshot hook) built TDD on loopback first, then the DO half proven in the workers lane. Peer-dep on core with a hand-written range.
