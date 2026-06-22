# Transport refactor — migration notes (for the deferred docs/README/skill update)

This file accumulates every user-visible change from the pluggable-transport work (`PLAN-transports.md`),
**one section per step**. At the end of the project we use it as the single checklist to update
`docs/` guide prose, package `README.md`s, and `skills/super-line/`. Code (`@example` doc-comments,
runnable `examples/`, tests) is migrated as each step lands; only narrative docs are deferred.

---

## Step 1 — Transport extraction + loopback (BUILT 2026-06-22)

### New packages

| Package | Purpose |
|---|---|
| `@super-line/transport-websocket` | The WebSocket transport. Owns all `ws`/`node:http` code: HTTP upgrade, 401 rejection, inspector subprotocol, backpressure. Exports `webSocketServerTransport`, `webSocketClientTransport`, `wsServerRawConn`, `Backpressure`. |
| `@super-line/transport-loopback` | In-memory client↔server transport (no socket). Exports `createLoopbackTransport()`. For tests / proving the interface. |

New core exports from `@super-line/core`: `RawConn`, `Handshake`, `AuthOutcome`, `ServerTransport`, `ClientTransport`, `PingFrame`, `PongFrame`.

### Breaking API changes (with before → after)

**1. Server: `server` → `transports`.**
```ts
// BEFORE
import { createSuperLineServer } from '@super-line/server'
const srv = createSuperLineServer(contract, { server: httpServer, authenticate })

// AFTER
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
const srv = createSuperLineServer(contract, {
  transports: [webSocketServerTransport({ server: httpServer })],
  authenticate,
})
```
- `path` moves into the transport: `webSocketServerTransport({ server, path: '/ws' })`.
- `backpressure` moves into the transport: `webSocketServerTransport({ server, backpressure: { maxBufferedBytes } })`. The `Backpressure` type now lives in `@super-line/transport-websocket` (no longer exported from `@super-line/server`).
- `inspector: true` STAYS on the server opts (gates `msg.*` telemetry) AND must also be passed to the transport (`webSocketServerTransport({ server, inspector: true })`) to negotiate the subprotocol. See "Inspector" below.

**2. Client: `url` → `transport`.**
```ts
// BEFORE
const client = createSuperLineClient(contract, { url: 'ws://localhost:3000', role: 'user' })

// AFTER
import { webSocketClientTransport } from '@super-line/transport-websocket'
const client = createSuperLineClient(contract, {
  transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
  role: 'user',
})
```
- A custom `WebSocket` impl moves into the transport: `webSocketClientTransport({ url, WebSocket })`.

**3. `authenticate(req)` → `authenticate(handshake)`.**
```ts
// BEFORE
authenticate: (req) => {
  const token = new URL(req.url ?? '', 'http://x').searchParams.get('token')
  ...
}
// AFTER
authenticate: (h) => {
  const token = h.query.token   // h: Handshake = { transport, headers, query, peer?, raw }
  ...
}
```
- Read query params via `h.query.X` (a `Record<string,string>`), headers via `h.headers`. `h.raw` is the escape hatch (the `IncomingMessage` for the WS transport).
- `authenticate` functions that ignore their argument need no change.

**4. `Conn.ws` removed.** `conn.ws.terminate()` → `conn.terminate()`; `conn.close()` still works. (Affects tests/tooling that simulated drops via `conn.ws`.)

### Behavioral changes
- **Heartbeat is now app-level frames.** The server sends `{t:'ping'}` and the client answers `{t:'pong'}` (was the WebSocket protocol ping). Consequence: heartbeat pings go through the normal send path, so a connection over its backpressure limit can be closed/dropped by the heartbeat (deliberate — app-level liveness is app data).
- **Logical-connection model.** The transport hides physical churn; the core's reconnect only fires on logical death (unchanged semantics: re-auth + re-subscribe, no session resume).
- **Inspector is server-authoritative.** Even if a transport negotiates the inspector subprotocol, the server refuses the inspector unless its own `inspector` flag is on. For the inspector to work, set `inspector: true` BOTH on the server opts and on `webSocketServerTransport`.

### Docs / README / skill files still showing the OLD API (update at the end)
The mechanical transform for each: server `{ server }`→`{ transports: [webSocketServerTransport({ server })] }`; client `{ url }`→`{ transport: webSocketClientTransport({ url }) }`; `authenticate(req)` reading `req.url`→`authenticate(h)` reading `h.query`; add the `@super-line/transport-websocket` import.

- **docs/ guides (11):** getting-started, roles-auth, react, reconnection-delivery, serialization, testing, control-center, middleware-lifecycle, topics, introspection-and-presence, scaling-adapters.
- **READMEs (8):** server, client, react, control-center, adapter-redis, adapter-rabbitmq, adapter-zeromq, adapter-libp2p.
- **skills/super-line/ (4):** SKILL.md, REFERENCE.md, AGENTS.md, RECIPES.md.
- `docs/reference/**` is typedoc-generated — regenerates from the (already-updated) source doc-comments on `docs:build`; do NOT hand-edit.
