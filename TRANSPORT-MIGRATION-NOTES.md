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

---

## Step 2 — HTTP transport: SSE + long-poll (BUILT 2026-06-22)

**Additive** — a new package, no breaking changes to existing API. Nothing in Step 1's migration list changes;
this only *adds* a transport to document.

### New package

`@super-line/transport-http` — carries the wire protocol over HTTP: **SSE** (or **long-poll**) downstream +
**POST** upstream, presenting one logical connection to the core. Exports `httpServerTransport`,
`httpClientTransport`, and their option types. Zero runtime deps beyond `@super-line/core` (server uses
`node:http`/`node:crypto`; client uses global `fetch` + an injected `EventSource`).

### Usage (to document — a new "HTTP / SSE transport" guide page)

```ts
// Server — composes on the SAME http.Server as the WS transport (HTTP owns 'request', WS owns 'upgrade')
import { httpServerTransport } from '@super-line/transport-http'
import { webSocketServerTransport } from '@super-line/transport-websocket'
const srv = createSuperLineServer(contract, {
  transports: [webSocketServerTransport({ server }), httpServerTransport({ server })],
  authenticate: (h) => ({ role: 'user', ctx: {} }), // same Handshake (h.query / h.headers) as WS; h.transport is 'sse'|'longpoll'
})

// Client (browser) — EventSource + fetch are global, nothing to inject
import { httpClientTransport } from '@super-line/transport-http'
const client = createSuperLineClient(contract, {
  transport: httpClientTransport({ url: 'http://localhost:3000' }), // mode: 'sse' (default) | 'longpoll'
  role: 'user',
})

// Client (Node) — EventSource is NOT global in Node; inject the `eventsource` package for SSE mode
import { EventSource } from 'eventsource'
httpClientTransport({ url: 'http://localhost:3000', EventSource })
// long-poll mode needs no EventSource (uses fetch only): httpClientTransport({ url, mode: 'longpoll' })
```

**Server options:** `server` (required), `basePath` (default `/superline`), `mode` (`'sse'|'longpoll'|'both'`,
default `'both'`), `sessionTimeout` (60s), `keepalive` (20s, SSE comment), `pollTimeout` (25s), `maxBodyBytes`
(1MB → 413), `cors` (opt-in). **Client options:** `url`, `basePath`, `mode` (`'sse'` default), `EventSource`
(inject in Node), `fetch` (inject; default global).

### Facts worth documenting
- **EventSource is not global in Node** (flag-gated even in v24) — Node SSE clients must pass `opts.EventSource`
  (the `eventsource` npm package); browsers have it natively. Long-poll mode needs only `fetch`.
- **Heavier than WS for big binary payloads** (base64 framing ≈ +33%); it's the fallback/compat transport.
- **Proxy notes:** SSE sets `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no` and writes a
  keepalive comment; behind buffering proxies that still break SSE, use `mode: 'longpoll'`.
- Reuses the same `authenticate(Handshake)` (query/headers), the same app-level ping/pong liveness, and the same
  no-session-resume reconnect model as WS — so docs can cross-reference the Step 1 concepts.

### Docs impact (add at the end, alongside the Step 1 sweep)
- A new guide page (e.g. `docs/guide/http-transport.md`) covering SSE vs long-poll, the EventSource-in-Node caveat,
  composing WS+HTTP on one server, and proxy guidance.
- `@super-line/transport-http` added to the package list / README index wherever transports are enumerated.

---

## Step 3 — libp2p transport (BUILT 2026-06-22)

**Additive** — a new package, no breaking changes to existing API.

### New package

`@super-line/transport-libp2p` — carries the wire protocol over a **libp2p protocol stream**. Exports
`libp2pServerTransport`, `libp2pClientTransport`, and their option types. **Bring-your-own node:** the transport
takes a started `Libp2p` node (the user picks the libp2p transports — ws / webrtc-direct / relayed-webrtc /
webtransport — and listen addrs). Runtime deps are only `@super-line/core` + `@libp2p/interface` (types) +
`@libp2p/utils` (`lpStream` framing); **`libp2p` is a peerDependency** (the user already builds the node). This
is a SEPARATE node from `@super-line/adapter-libp2p` (which runs gossipsub for server↔server fan-out).

### Usage (to document — a new "libp2p / WebRTC transport" guide page)

```ts
// Server — register the protocol on a started node
import { libp2pServerTransport } from '@super-line/transport-libp2p'
const srv = createSuperLineServer(contract, {
  transports: [libp2pServerTransport({ node /*, protocol: '/super-line/1.0.0' */ })],
  authenticate: (h) => ({ role: h.query.role, ctx: {} }), // h.transport === 'libp2p'; h.peer = { id, addr }; role+params come from the first stream frame
})

// Client — dial the server's multiaddr(s)
import { libp2pClientTransport } from '@super-line/transport-libp2p'
const client = createSuperLineClient(contract, {
  transport: libp2pClientTransport({ node: clientNode, multiaddr: serverNode.getMultiaddrs() }),
  role: 'user',
})
```

### Facts worth documenting
- **Bring-your-own libp2p node.** The transport never creates/stops the node; the user configures it
  (`createLibp2p({ transports, connectionEncrypters: [noise()], streamMuxers: [yamux()] })`). For a browser→server
  WebRTC deployment the node uses `@libp2p/webrtc`; libp2p owns the signaling (we never write any) — see
  `PLAN-transports.md §3` for the webrtc-direct / circuit-relay-v2 connectivity matrix.
- **Auth is the first stream frame** (libp2p has no HTTP headers/query): the client sends `{role, params}` as the
  first length-prefixed frame; the server reads it, builds the `Handshake` (`peer.id` = noise-verified PeerId,
  `peer.addr` = remote multiaddr), runs `authenticate`, and aborts the stream on reject. Same
  `authenticate(Handshake)` shape as the other transports.
- **Length-prefix framed** (`lpStream`): a libp2p `'message'` event does NOT preserve frame boundaries (yamux
  chunks large sends), so the transport length-prefixes every frame. Invisible to the app.
- Reuses the same app-level ping/pong liveness and the same no-session-resume reconnect model as the other transports.

### Docs impact (add at the end, alongside the Step 1 sweep)
- A new guide page (e.g. `docs/guide/libp2p-transport.md`) covering bring-your-own-node, the first-frame auth,
  the WebRTC/relay connectivity matrix, and the separate-node-from-adapter-libp2p note.
- `@super-line/transport-libp2p` added to the package list / README index wherever transports are enumerated.

---

## All transports — final package list (for the docs/README sweep)
`@super-line/core` (interfaces) · `@super-line/transport-websocket` · `@super-line/transport-http` (sse+longpoll) ·
`@super-line/transport-libp2p` (libp2p family / webrtc) · `@super-line/transport-loopback` (in-memory test substrate).
