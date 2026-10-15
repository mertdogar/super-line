---
id: T15
title: Build the connection snapshot seam on loopback
labels: [wayfinder:task]
status: closed
assignee: claude session 2026-10-15 (T15)
closed: 2026-10-15
blocked-by: [T05]
---

## Question

The core/server/client half of PLAN-cloudflare §1–§3, built TDD on the fast lane with no Cloudflare involved: `ConnectionSnapshot` + `adoptConnection`/`snapshotOf`/`onSnapshotChanged` in core and server (recording at frame ingress, rooms, muted replay from a reserved id range, mandatory `connectionId` written back, `env` doc-comment reworded, `conn.data` re-seed documented); the `end` frame (server → client, three kinds) with its client routing and tap vocabulary; `liveness: 'socket'` suppressing the heartbeat timer; inbound `ping` → `pong` on the server and the client `keepalive` option; `PluginContext.hold()` + `onHold`; plugin-chat taking a hold per open stream; plugin `snapshotConnection`/`restoreConnection` hooks (no first-party implementer yet). Promote the T04 prototype's hibernating loopback into `transport-loopback` (`createHibernatingLoopback()`, test-only export) and turn the prototype scenario into the contract test. Public-surface change → all four `skills/super-line/` files. Typecheck, lint, fast lane green.

## Resolution

**Built**, TDD on the fast lane, no Cloudflare. Contract test: `packages/server/test/hibernation.integration.test.ts` (8 tests) over `packages/server/test/hibernating-loopback.ts`, a test transport whose sockets outlive the server instance and whose snapshots are JSON round-tripped.

What now exists:
- **core**: `ConnectionSnapshot { auth(+connectionId), connectedAt, rooms, frames }`; `ServerTransport.liveness`, `.onSnapshotChanged`, `.onHold`; start hook `adoptConnection(raw, snapshot)`; `EndFrame` (`t: 'end'`, kind topic | collection | doc).
- **server** (`src/snapshot.ts` + `index.ts`): a subscribe enters the snapshot only when acknowledged, leaves on unsubscribe; rooms come from `conn.channels`; `env` is the current one; pushed synchronously from accept onward, never after close. Adoption = ordinary accept (original `connectedAt`) + room rejoin + replay through the normal handlers with ids ≥ 2^30 whose acks are withheld; a refused replay becomes an `end` frame. The interception is one package-internal `replyHooks` lookup in `Conn.send`. Inbound `ping` → `pong`. No heartbeat timer when every transport has `liveness: 'socket'`. `PluginContext.hold()` → `onHold(count)`.
- **client**: `end` → `onError(err, { kind: 'resubscribe', collection | collection+id | topic })` (topic listeners dropped, as on a denied subscribe); `keepalive?: number` pings and drops a socket that went silent.
- **plugin-chat**: a busy token per open stream, released on settle (test: two streams → holds `[1, 2, 1, 0]`).
- **devtools panel**: labels the `end` frame. **Skills**: all four files. `Conn.env` doc-comment reworded.

Deviations from the locked plan (recorded in PLAN-cloudflare "As built" and ADR-0027): no `snapshotOf`; no plugin `snapshotConnection`/`restoreConnection` and no `plugins` field (no implementer — returns with the chat-stream fog item); `onHold` is on `ServerTransport`; the transport names the connection id; the hibernating loopback is a test helper, so `transport-loopback` needs no release.

Verification: root typecheck + test-workers + devtools-extension clean; Control Center unchanged at its 35 pre-existing JSX-icon errors; lint clean; fast lane 90 files / 853 tests green (one earlier full run had two chat timeouts that passed alone and on the rerun — load flakes, both over the WebSocket transport, untouched by the snapshot path); workers lane 7/7; heavy lane 33 files, 158 passed, 6 skipped.
