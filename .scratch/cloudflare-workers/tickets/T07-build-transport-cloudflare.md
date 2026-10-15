---
id: T07
title: Build @super-line/transport-cloudflare
labels: [wayfinder:task]
status: closed
assignee: claude session 2026-10-15 (T07)
closed: 2026-10-15
blocked-by: [T06,T15]
---

## Question

The DO WebSocket transport: a `ServerTransport` over the Hibernation API (accept, tag, message/close/error routing to `RawConn`), a `fetch` helper the Worker/DO uses to route upgrades (and the reserved-connection subprotocol dance that `transport-websocket` does, including the 4401-after-upgrade refusal), socket-level liveness via auto-response replacing the server heartbeat (the timer seam from T05), and **wake**: on construction, adopt `ctx.getWebSockets()` through the snapshot/restore seam. The core half of the seam is T15; this ticket builds only the Cloudflare half per PLAN-cloudflare §4 (`routeToNode`, `createDurableNode`, `_sl_conn` snapshot table, 4409 fallback, auto-response liveness, `onHold` → `waitUntil`) and proves it in the workers lane. Peer-dep on core with a hand-written range.

## Resolution

**Built.** `@super-line/transport-cloudflare` 0.1.0 (unreleased): `cloudflareServerTransport(ctx)`, `createDurableNode(build)`, `routeToNode(req, ns, { name })`, `CLOSE_NOT_RESUMABLE` (4409). ESM-only; peers core `>=0.20.0` (raise at T13); excluded from root typecheck and checked by its own tsconfig inside `pnpm typecheck`.

Proven in the workers lane against real Durable Objects (`test-workers/`):
- the transport-neutral WebSocket contract: Handshake from the request + bytes both ways; a plain 401 when `authenticate` throws; a reserved subprotocol accepted without the host `authenticate` (and echoed in the 101); a reserved refusal closed **4401 after the upgrade**;
- liveness: a client `{"t":"ping"}` is answered `{"t":"pong"}` **by the platform** (the server would have echoed it upper-cased; `getWebSocketAutoResponseTimestamp` is set);
- wake: after `evictDurableObject`, the next request wakes a **new instance** (constructor count 1 → 2) and the topic subscription delivers with zero client lifecycle events; a subscription the woken instance refuses arrives on the client's `onError` (`resubscribe`, `{ topic }`) with the socket open; a socket whose snapshot row is gone is closed **4409** and the client reconnects; closing the client deletes its snapshot row.
- Fast lane: a held busy token keeps exactly one timer pending (`vi.getTimerCount`).

Facts that changed the plan (recorded in PLAN-cloudflare "As built (T07)"): **`waitUntil` does nothing in a Durable Object** (T01 was wrong) — the busy token holds a no-op interval instead, and a non-hibernatable idle object is still evicted after 70–140 s; `adoptConnection` now returns a promise so `resume()` finishes inside `blockConcurrencyWhile`; `routeToNode` uses `getByName`.

Also: `scripts/check-manifest.mjs` treats `cloudflare:*` like `node:*` (runtime modules); `zod` added to root devDependencies for `test-workers/`; skills (all four) + CLAUDE.md updated. README is T12's.
