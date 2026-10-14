---
id: T04
title: Prototype the connection snapshot/restore seam
labels: [wayfinder:prototype]
status: open
assignee:
blocked-by: [T01]
---

## Question

The hardest unknown: can a live connection's server-side state be captured, persisted, and rebuilt on a fresh server instance such that the client never notices? Prototype it on the loopback transport, no Cloudflare involved. Inventory every piece of per-connection state the server holds (ctx/identity/env, rooms/topics, collection subscriptions + their query IR, open CRDT docs, in-flight requests, streaming chat writers, inspector reserved-connection state, plugin-owned per-connection state via `setup(ctx)`), classify each as *restorable from a snapshot*, *re-derivable*, or *lost* (and whether lost is acceptable — e.g. an in-flight request on a hibernated socket). Produce a rough `exportConnection(connId) → Snapshot` / `adoptConnection(raw, snapshot)` shape and measure a realistic snapshot size (decides attachment vs DO SQLite given T01's limit). Surface what plugins must contribute (a per-connection snapshot hook?). Throwaway code; the answer is the inventory + shape + size, recorded in the resolution.
