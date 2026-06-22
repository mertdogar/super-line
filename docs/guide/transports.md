# Transports

super-line separates **what** travels (the contract — requests, events, topics, validated and routed by the
server-authoritative core) from **how** it travels (the wire). The "how" is a pluggable **transport**: the server
accepts connections on one or more transports, the client dials on one.

The transport only moves opaque bytes over a *logical* connection — it hides physical churn (HTTP's many requests,
SSE/EventSource reconnects, peer signaling) and never inspects a frame. The serializer, validation, rooms, topics,
liveness (app-level ping/pong) and reconnect semantics live in the core, identically across every transport.

```ts
// server: one or more transports
createSuperLineServer(contract, { transports: [webSocketServerTransport({ server })], authenticate })
// client: one transport
createSuperLineClient(contract, { transport: webSocketClientTransport({ url: 'ws://localhost:3000' }), role: 'user' })
```

`authenticate` always receives a normalized **Handshake** — `{ transport, headers, query, peer?, raw }` — so the
same auth code works on every transport (read `h.query.token`, `h.headers`, or for peer transports `h.peer`).

## Available transports

| Package | Wire | Use it for |
|---|---|---|
| `@super-line/transport-websocket` | WebSocket (full-duplex) | the default — lowest latency, broadest support |
| `@super-line/transport-http` | SSE or long-poll downstream + POST upstream | restrictive networks/proxies where WS is blocked |
| `@super-line/transport-libp2p` | libp2p protocol stream (ws / WebRTC / WebTransport) | p2p / WebRTC deployments; bring your own libp2p node |
| `@super-line/transport-loopback` | in-memory (no socket) | tests — wire a real server + client in one process |

Transports compose: a server can list several (`transports: [webSocketServerTransport({ server }),
httpServerTransport({ server })]`) on the same `http.Server` — WS uses the HTTP `upgrade` channel, HTTP uses the
`request` channel, so they never collide.

## WebSocket (default)

```ts
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'

// server
webSocketServerTransport({ server, path: '/ws', backpressure: { maxBufferedBytes: 1_000_000 } })
// client (browser: WebSocket is global; Node < 22: pass `WebSocket`)
webSocketClientTransport({ url: 'wss://api.example.com' })
```

`path`, `backpressure`, and the Control Center `inspector` subprotocol are WS-transport options.

## HTTP — SSE & long-poll

For environments that block or buffer WebSocket. SSE (`EventSource`) or long-poll downstream, `POST` upstream,
over one logical session.

```ts
import { httpServerTransport, httpClientTransport } from '@super-line/transport-http'

// server — mount on the same http.Server as WS
httpServerTransport({ server, basePath: '/superline' })

// browser client (EventSource + fetch are global)
httpClientTransport({ url: 'https://api.example.com', mode: 'sse' })
```

In **Node**, `EventSource` isn't global — pass one (the `eventsource` npm package) for SSE mode, or use
`mode: 'longpoll'` (which needs only `fetch`):

```ts
import { EventSource } from 'eventsource'
httpClientTransport({ url, EventSource })          // sse
httpClientTransport({ url, mode: 'longpoll' })     // fetch-only
```

Notes: base64 framing makes the HTTP transport heavier than WS for large binary payloads (it's the
compat/fallback wire); behind proxies that buffer SSE, prefer `mode: 'longpoll'`.

## libp2p (incl. WebRTC)

Carries the wire over a libp2p protocol stream. **Bring your own started `Libp2p` node** — you choose its
transports (`@libp2p/websockets`, `@libp2p/webrtc` for WebRTC-direct/relayed, `@libp2p/webtransport`) and listen
addresses; libp2p owns any WebRTC signaling, so super-line writes none. (This is a *separate* node from
`@super-line/adapter-libp2p`, which is server↔server fan-out.)

```ts
import { libp2pServerTransport, libp2pClientTransport } from '@super-line/transport-libp2p'

// server: register the protocol on a node
libp2pServerTransport({ node })
// client: dial the server's multiaddr(s)
libp2pClientTransport({ node: clientNode, multiaddr: serverNode.getMultiaddrs() })
```

libp2p has no HTTP headers/query, so auth rides the **first stream frame**: the client sends `{ role, params }`,
and `authenticate` receives a Handshake with `transport: 'libp2p'`, `query: { role, ...params }`, and
`peer: { id, addr }` (the noise-verified PeerId). The package depends only on `@super-line/core`,
`@libp2p/interface`, and `@libp2p/utils`; **`libp2p` is a peerDependency** (you already build the node).

## Loopback (tests)

Wire a real server and client in one process with no socket — ideal for fast, deterministic tests.

```ts
import { createLoopbackTransport } from '@super-line/transport-loopback'

const loopback = createLoopbackTransport()
const srv = createSuperLineServer(contract, { transports: [loopback.server], authenticate })
const client = createSuperLineClient(contract, { transport: loopback.client(), role: 'user' })
```

## What stays the same on every transport

- **`authenticate(handshake)`** and the server-authoritative model (roles fixed at connect; cross-role → `NOT_FOUND`).
- **Liveness** — app-level ping/pong frames the core sends/answers; no per-transport heartbeat.
- **Reconnect** — a dropped logical connection re-authenticates and re-subscribes (no session resume). The
  transport hides physical reconnects beneath that.
- **Validation, rooms, topics, the cluster `Adapter`** — all unchanged; the transport is just the pipe.
