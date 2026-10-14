# Research: Durable Object WebSocket Hibernation API

Researched 2026-10-14 against developers.cloudflare.com (fetched pages and the Context7 index of the same docs). Every fact carries its source URL. Where the docs are silent, this file says "not documented".

Sources (short names):
- [WS] https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- [STATE] https://developers.cloudflare.com/durable-objects/api/state/
- [BASE] https://developers.cloudflare.com/durable-objects/api/base/
- [ALARMS] https://developers.cloudflare.com/durable-objects/api/alarms/
- [LIFE] https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- [LIMITS] https://developers.cloudflare.com/durable-objects/platform/limits/
- [WLIMITS] https://developers.cloudflare.com/workers/platform/limits/
- [MEM] https://developers.cloudflare.com/durable-objects/reference/in-memory-state/
- [WSREF] https://developers.cloudflare.com/durable-objects/reference/websockets/
- [EXAMPLE] https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server
- [GLOSSARY] https://developers.cloudflare.com/durable-objects/reference/glossary

## Headline numbers

| Item | Value | Source |
|---|---|---|
| Attachment size (serializeAttachment) | 16,384 bytes serialized | [WS], [WSREF] |
| Max hibernatable WebSockets per DO | 32,768 (practical cap may be lower from CPU/memory) | [STATE] acceptWebSocket |
| Idle time before hibernation | 10 seconds of no event, all other conditions met | [LIFE] |
| Idle, non-hibernatable eviction | 70-140 seconds | [LIFE] |
| Inbound WS message size | 32 MiB (received messages only) | [LIMITS] |
| Tags per socket / tag length | 10 / 256 chars | [STATE] |
| Auto-response request/response size | 2,048 chars each | [STATE] |
| Memory | 128 MB per isolate (not per DO), JS heap + Wasm | [WLIMITS], [MEM] |

## 1. Hibernation API surface

- `ctx.acceptWebSocket(ws, tags?)`: adds the socket to the DO's hibernatable set. Messages go to `webSocketMessage`, disconnects to `webSocketClose`. `ws.accept()` must not also be called and `addEventListener` gets no events. [STATE]
- Tags: optional `Array<string>`, max 10 tags, 256 chars each. [STATE]
- `ctx.getWebSockets(tag?)`: returns `Array<WebSocket>`, optionally filtered by tag. Disconnected sockets are excluded, but one in the closing state may still be returned. [STATE]
- Handlers on the DO class [BASE]:
  - `webSocketMessage(ws, message: string | ArrayBuffer)`: not called for control frames.
  - `webSocketClose(ws, code, reason, wasClean)`: reason may be empty.
  - `webSocketError(ws, error: unknown)`: called for non-disconnection errors; check the type before reading `.message`.
- Attachments [WS]:
  - `ws.serializeAttachment(value)` keeps a copy of `value` with the connection; max 16,384 bytes serialized. Docs advise storing larger data in the Storage API and keeping only the key in the attachment.
  - `ws.deserializeAttachment()` returns the last value, or `null`.
  - Attachments survive hibernation "as long as the WebSocket remains healthy" and are lost when either side closes.
- Restore pattern from the official example: in the constructor, loop `ctx.getWebSockets()` and `deserializeAttachment()` to rebuild the in-memory session map. [EXAMPLE]

Design implication: 16 KiB is far too small for a subscription-heavy connection snapshot (topics, collection subscription queries, open docs). The docs' own guidance is attachment holds a key, state holds the rest. That supports the map's expectation of DO SQLite keyed by connection id, with the attachment carrying only the connection id.

## 2. Auto-response and what keeps a DO awake

- `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(req, res))` answers a matching text message without waking a hibernated DO. Pair limited to 2,048 chars each. Calling with no argument removes it. `getWebSocketAutoResponse()` returns the pair or null. `getWebSocketAutoResponseTimestamp(ws)` returns the last auto-response time for a socket. [STATE]; the "does not wake hibernated WebSockets" claim is in the example comment [EXAMPLE].
- Protocol ping frames get automatic pong replies and do not interrupt hibernation. [WS], [BASE]
- Hibernation is blocked by [LIFE], [WS]:
  - scheduled `setTimeout` / `setInterval` callbacks
  - unfinished I/O or `waitUntil()` promises
  - an open outbound connection (outbound WebSockets never hibernate; can block eviction up to 15 minutes)
  - use of the standard (non-hibernation) WebSocket API
  - any request or event still being processed
  - alarms, incoming requests and scheduled callbacks count as events [WS]
- `waitUntil(promise)` blocks eviction until it settles or 15 minutes. [STATE]
- Design implication: the server's `setInterval` heartbeat must not run on a hibernating node. Liveness has to come from socket-level ping/auto-response, as the map already decided.

## 3. Wake lifecycle

- On an event for a hibernated DO the runtime re-initialises it and the constructor runs again, then the invoked handler. In-memory state is reset. [WS], [LIFE], [EXAMPLE]
- Docs advise: "Minimize work in the constructor when using hibernation." [WS]
- `blockConcurrencyWhile(cb)`: blocks all events not initiated by the callback until it finishes; commonly used in the constructor. 30 s timeout, and a throw or timeout resets the DO. [STATE]
- Input gates: while a storage operation runs, no other events are delivered except storage completions. SQLite storage operations are synchronous and do not yield the event loop. [GLOSSARY], [STATE]
- Can a message arrive before the constructor finishes? The docs state the constructor runs before the invoked function [LIFE]. They state events are blocked during `blockConcurrencyWhile` [STATE]. They give no further explicit ordering guarantee between handlers [BASE]. Not documented beyond that: whether async work started un-awaited in the constructor can interleave with the first handler. Safe design: do all restore work inside `blockConcurrencyWhile` or synchronously.
- States: Active, Idle non-hibernatable, Idle hibernatable, Hibernated, Inactive. [LIFE]

## 4. Close and eviction semantics

- Hibernated DOs keep clients connected. [LIFE], [WSREF]
- "Code updates disconnect all WebSockets." Deploys restart every DO and drop connections. [WS], [WSREF]
- Shutdown reasons listed: new deployments, lack of requests after state transitions, Cloudflare runtime updates, runtime decisions on where to host objects. Memory pressure is not mentioned. [LIFE]
- Close codes the client sees on deploy or eviction-with-disconnect: not documented. [WSREF]
- Docs say WebSocket requests are terminated automatically during shutdown and a new instance can take over; no mechanism or code is given. [LIFE]
- With compat flag `web_socket_auto_reply_to_close` (default for compat date >= 2026-04-07) the runtime sends the reciprocal Close frame before `webSocketClose` runs and `close()` is safe but unnecessary. On older dates, not calling `ws.close(code, reason)` in the handler makes the client see 1006. [BASE], [WS]
- `setHibernatableWebSocketEventTimeout(ms)`: max 604,800,000 ms (7 days); 0 or omitted unsets it. [STATE] The docs fetched here do not explain what the timeout bounds; read the API page before relying on it.
- Local dev: before wrangler 3.13.2 / Miniflare 3.20231016.0 sockets did not hibernate locally. [WS]

## 5. Alarms

- API: `ctx.storage.getAlarm()`, `setAlarm(epochMs)`, `deleteAlarm()`; handler `alarm(alarmInfo?: {retryCount, isRetry})`. [ALARMS]
- Granularity: milliseconds since epoch; no finer or coarser precision documented. [ALARMS]
- One alarm per DO at a time; `setAlarm` overwrites an existing one. Only one `alarm()` runs at a time per DO. For many events, keep them in storage and re-arm for the next due time. [ALARMS]
- Guarantees: at-least-once; uncaught exception triggers retry with exponential backoff starting at 2 s, up to 6 retries, applying to the latest `setAlarm` only. Recommended to catch and re-arm to continue past 6 failures. [ALARMS], [BASE]
- `deleteAlarm()` inside the handler may suppress retries, best-effort only. [ALARMS]
- Wall time per alarm invocation: 15 minutes. [LIMITS], [WLIMITS]. (The alarms page itself states no limit.)
- Does an alarm wake a hibernated DO? Not stated outright. The docs say the constructor runs before `alarm()` if the object was inactive, and that alarms count among events that prevent hibernation. [ALARMS], [WS]
- Judgement for the queue-cron fog: a single-slot, ms-resolution, at-least-once alarm that re-arms itself fits an "earliest due job or schedule" tick. Confirm alarm wake-from-hibernation empirically in the workers test lane before relying on it.

## 6. Limits

- WebSockets per DO: 32,768 with the Hibernation API [STATE]. The platform limits page says not documented [LIMITS]; the WebSocket guide only says "thousands of clients per instance" [WS].
- Message size: 32 MiB for received messages. Outbound size not documented. [LIMITS]
- Memory: 128 MB per isolate, shared by everything in that isolate, and no separate per-DO figure is documented. [WLIMITS], [MEM]
- CPU: 30 s default per invocation (HTTP request, WS message or alarm), configurable to 5 min via `limits.cpu_ms`; each message resets the budget; I/O wait does not count. [LIMITS]
- SQLite-backed storage: 10 GB per DO on Paid; max row/string/BLOB 2 MB; max 100 columns per table; max SQL statement 100 KB; max 100 bound parameters per query. The page contradicts itself on the Free per-DO limit (table implies 5 GB per account, FAQ says 1 GB). [LIMITS]
- KV-backed storage: 2 KiB key, 128 KiB value. [LIMITS]
- Batch outbound sends: docs recommend grouping 10-100 logical messages per frame. [WS]

## Open questions the docs do not answer

- Close code a client sees when a DO is evicted or reset while sockets stay open (only deploys are stated to disconnect).
- Whether a message can interleave with un-awaited constructor work.
- Whether an alarm wakes a hibernated DO (implied, not stated).
- Exact meaning of the hibernatable-event timeout.
- Per-DO memory ceiling.
