---
id: T01
title: Research: Durable Object WebSocket Hibernation API
labels: [wayfinder:research]
status: closed
assignee: research agent (2026-10-14)
closed: 2026-10-14
blocked-by: []
---

## Question

Establish the facts the hibernation design hangs on, from Cloudflare's own docs (Context7 / developers.cloudflare.com), with citations:
- The Hibernation API surface: `ctx.acceptWebSocket`, `webSocketMessage`/`webSocketClose`/`webSocketError` handlers, `ctx.getWebSockets(tag?)`, tags, `ws.serializeAttachment` / `deserializeAttachment` and the **attachment size limit** (this decides whether per-connection snapshots live in the attachment or in DO SQLite).
- `setWebSocketAutoResponse` (ping/pong without waking) and what else keeps a DO awake (timers, in-flight promises, non-hibernated sockets).
- Wake lifecycle: what runs on wake (constructor, `blockConcurrencyWhile`), ordering guarantees, whether messages can arrive before the constructor finishes, max idle before eviction.
- Close semantics during hibernation: what the client sees if the DO is evicted for other reasons (deploy, memory), close codes.
- DO alarms: API, granularity, guarantees — enough to judge the queue-cron fog later.
- Limits: max WebSockets per DO, message size, memory.
Write findings to `.scratch/cloudflare-workers/assets/research-do-hibernation.md`.

## Resolution

Findings: [assets/research-do-hibernation.md](../assets/research-do-hibernation.md), every fact cited to developers.cloudflare.com.

- Attachment limit is 16,384 bytes serialized, so per-connection snapshots belong in DO SQLite keyed by connection id; the attachment carries only the id.
- Max hibernatable sockets per DO is 32,768 (state API page); the platform limits page does not list one.
- Hibernation starts after 10 s idle; timers, in-flight I/O, waitUntil, outbound sockets and standard-API sockets block it, so the heartbeat setInterval must go.
- Ping frames and `setWebSocketAutoResponse` pairs (2,048 chars each) are answered without waking the DO.
- Wake reruns the constructor before the handler; use `blockConcurrencyWhile` (30 s cap) for restore. Interleaving of un-awaited constructor work is not documented.
- Deploys disconnect all sockets; the close code seen on eviction or deploy is not documented.
- Alarms: one per DO, ms epoch, at-least-once, 2 s backoff with 6 retries, 15 min wall time; wake-from-hibernation implied but unconfirmed.
- Inbound message cap 32 MiB; memory is 128 MB per isolate, no per-DO figure.
- Open items to verify empirically in the workers lane: alarm wake, eviction close code, constructor ordering.
