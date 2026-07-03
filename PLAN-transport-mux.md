# PLAN — @super-line/transport-mux (DEFERRED)

- Status: **Deferred** (designed 2026-07-03, not built). See ADR-0004 — composition won for the embedding use case; this plan exists so the design isn't lost.
- Revive when: a consumer needs **two independent SuperLine stacks** (own contract, own `authenticate`, own lifecycle — e.g. third-party embedding, separate teams) sharing **one physical socket**. If the stacks can share identity, use composition (`defineSurface`/`mergeSurfaces`) instead.

## Shape

A leaf transport package, zero changes to core/server/client. Wraps **any** inner transport pair (WS/HTTP/loopback), multiplexing N logical "lines" over 1 physical connection. Fits the transport seam's charter verbatim: "a transport moves opaque encoded bytes over a LOGICAL connection and hides all physical churn."

```ts
// server — one physical listener, two logical servers
const mux = muxServerTransport(webSocketServerTransport({ server }))
createSuperLineServer(appContract,  { transports: [mux.line('app')], authenticate: appAuth })
createSuperLineServer(libContract,  { transports: [mux.line('lib')], authenticate: libAuth })

// client — one WebSocket, two logical clients
const mux = muxClientTransport(webSocketClientTransport({ url }))
createSuperLineClient(appContract, { transport: mux.line('app'), role: 'user', params })
createSuperLineClient(libContract, { transport: mux.line('lib'), role: 'user', params })
```

## Wire envelope

Binary, serializer-agnostic — payload bytes pass through untouched:

```
OPEN     0x01  lineId, lineName, handshakeParams(JSON)
OPEN_OK  0x02  lineId
OPEN_ERR 0x03  lineId, code, reason        ← per-line auth rejection
DATA     0x04  lineId, payload bytes as-is  ← one whole super-line frame, opaque
CLOSE    0x05  lineId, code, reason         ← line dies, socket survives
```

## Server side

- Each `mux.line(name)` facade is a `ServerTransport`; its `start(hooks)` registers `{authenticate, onConnection}` in a routing table. First `start` starts the inner transport; last `stop` stops it.
- The physical layer gets an accept-all authenticate; **real auth is per line**: inbound `OPEN` → look up the line → call that server's own `authenticate` with a synthesized `Handshake{ transport: 'mux+websocket', headers: physicalHeaders, query: openParams }`. Physical headers (cookies) merged in → cookie-based identity shared for free. Success → mint a virtual `RawConn` (send = DATA-wrap; close = CLOSE frame, socket survives) → line's `onConnection` → `OPEN_OK`. Throw → `OPEN_ERR`.
- Unknown line name → `OPEN_ERR` (the 404 of lines).

## Client side

- `line(name).connect(params, hooks)` refcounts the physical dial: first caller dials, others attach to the in-flight dial or live socket; then each line sends its own `OPEN`.
- **Zero changes to the client package's reconnect loop**: physical drop → all virtual conns fire `onClose` → each `SuperLineClient` independently backs off and redials → the mux dedupes to one physical dial. Per-line `OPEN_ERR` closes only that line's virtual conn.

## Semantics

- `writable`/`onDrain`: mirror the physical socket, fanned out to all lines.
- Heartbeat reaping `terminate()`s a *line*, never the socket (heartbeat is core frame-level, per session — so N lines = N ping/pong streams over one socket).
- Socket closes when the last line closes (refcount), or on physical death (all lines see `onClose`).

## Known costs (why it lost to composition for embedding)

1. Accept-all physical auth → unauthenticated sockets can idle; needs an idle-without-lines reap timer (new DoS-surface nuance vs. today's reject-at-upgrade).
2. Doubled frame-level heartbeats, forever.
3. Inspector routing: `inspector: true` lives on the physical WS transport, owned by no line. Workaround: each server adds its own dedicated `webSocketServerTransport({ server, path: '/cc-<name>', inspector: true })` — "one socket" quietly becomes "one socket + one per server for the debugger".
4. Head-of-line blocking: one line's flood (e.g. a store snapshot) stalls the sibling's frames mid-stream.
5. Shared identity only by convention: two `authenticate`s must agree on the same token, forever.

Estimate: ~350 lines + tests + docs, plus a permanent "composition or mux?" decision page.
