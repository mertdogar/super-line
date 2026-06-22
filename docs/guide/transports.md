# Choose your wire

super-line separates **what** travels — your typed contract: requests, events, topics, validated and routed by a server-authoritative core — from **how** it travels: the **transport**.

That separation is the point. The same server, the same client, the same handlers run over a WebSocket, an HTTP/SSE stream, or a libp2p/WebRTC peer connection. **The transport is one line; everything above it is identical.**

```ts
// the ONLY thing that changes between wires:
webSocketClientTransport({ url: 'ws://localhost:3000' })   // WebSocket
httpClientTransport({ url: 'http://localhost:3000' })       // HTTP — SSE / long-poll
libp2pClientTransport({ node, multiaddr })                  // libp2p / WebRTC
loopbackTransport.client()                                  // in-memory (tests)
```

```ts
const client = createSuperLineClient(contract, {
  transport: webSocketClientTransport({ url: 'ws://localhost:3000' }), // ← swap this one line
  role: 'user',
})
await client.send({ room: 'lobby', text: 'hi' }) // identical on every wire
```

A server can even accept **several at once** on one `http.Server`:

```ts
createSuperLineServer(contract, {
  transports: [webSocketServerTransport({ server }), httpServerTransport({ server })],
  authenticate,
})
```

WebSocket uses the HTTP `upgrade` channel and HTTP uses the `request` channel, so they coexist without collision — a browser that can't open a WebSocket falls back to HTTP against the very same server.

## Which wire?

| If you need… | Use | Package |
|---|---|---|
| The default — lowest latency, full-duplex, broadest support | **WebSocket** | [`@super-line/transport-websocket`](./transport-websocket) |
| To survive restrictive networks / proxies that block or buffer WebSocket | **HTTP** (SSE or long-poll) | [`@super-line/transport-http`](./transport-http) |
| Peer-to-peer / **WebRTC** / WebTransport, browser↔server with no signaling code | **libp2p** | [`@super-line/transport-libp2p`](./transport-libp2p) |
| Fast, deterministic tests with a real server + client in one process | **Loopback** | [`@super-line/transport-loopback`](./transport-loopback) |

Start with WebSocket. Reach for HTTP as a fallback wire, libp2p when you want WebRTC/p2p, and loopback in your test suite.

## One handshake, every wire

`authenticate` always receives a normalized **Handshake** — the same shape regardless of transport — so your auth code is written once:

```ts
authenticate: (h) => {
  // h: { transport, headers, query, peer?, raw }
  const token = h.query.token        // WS/HTTP carry it on the URL; libp2p carries it in the first frame
  // h.peer = { id, addr } for peer transports (the verified PeerId)
  return { role: 'user', ctx: verify(token) }
}
```

## What every transport shares

The transport only moves opaque bytes over a *logical* connection and never inspects a frame. Everything else lives in the core and behaves identically on every wire:

- **Server-authority** — roles fixed at connect; the server owns rooms/topics and validates every inbound message; cross-role calls → `NOT_FOUND`.
- **Liveness** — app-level ping/pong frames the core sends and answers; no per-transport heartbeat.
- **Reconnect** — a dropped logical connection re-authenticates and re-subscribes (no session resume). The transport hides the *physical* churn (HTTP's many requests, SSE reconnects, peer re-dials) beneath that one logical connection.
- **Validation, rooms, topics, serialization, and the cluster `Adapter`** — unchanged. The transport is just the pipe.

::: tip Transports vs adapters
A **transport** is the *client↔server* wire (this page). An [**adapter**](./scaling-adapters) is the *server↔server* fan-out substrate for multi-node clusters (Redis, libp2p, …). They're independent — you pick each separately.
:::

Next: pick a wire — [WebSocket](./transport-websocket) · [HTTP](./transport-http) · [libp2p & WebRTC](./transport-libp2p) · [Loopback](./transport-loopback).
