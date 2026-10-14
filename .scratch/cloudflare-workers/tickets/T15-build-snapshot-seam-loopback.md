---
id: T15
title: Build the connection snapshot seam on loopback
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [T05]
---

## Question

The core/server/client half of PLAN-cloudflare §1–§3, built TDD on the fast lane with no Cloudflare involved: `ConnectionSnapshot` + `adoptConnection`/`snapshotOf`/`onSnapshotChanged` in core and server (recording at frame ingress, rooms, muted replay from a reserved id range, mandatory `connectionId` written back, `env` doc-comment reworded, `conn.data` re-seed documented); the `end` frame (server → client, three kinds) with its client routing and tap vocabulary; `liveness: 'socket'` suppressing the heartbeat timer; inbound `ping` → `pong` on the server and the client `keepalive` option; `PluginContext.hold()` + `onHold`; plugin-chat taking a hold per open stream; plugin `snapshotConnection`/`restoreConnection` hooks (no first-party implementer yet). Promote the T04 prototype's hibernating loopback into `transport-loopback` (`createHibernatingLoopback()`, test-only export) and turn the prototype scenario into the contract test. Public-surface change → all four `skills/super-line/` files. Typecheck, lint, fast lane green.
